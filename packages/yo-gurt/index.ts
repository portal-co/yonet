/*
 * TypeScript implementation of the GURT protocol (v1.0.0).
 * Based on the Rust crate at: crates/yo-gurt/src/lib.rs
 * and documentation: crates/yo-gurt/README.md
 * Specification: https://github.com/outpoot/gurted/blob/main/docs/docs/gurt-protocol.md
 *
 * Citations in code reference the original crate where applicable.
 */

import { Duplex } from 'stream';

export const GURT_VERSION = 'GURT/1.0.0';
export const DEFAULT_PORT = 4878;
export const ALPN_IDENTIFIER = 'GURT/1.0';
export const MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_CONNECTION_TIMEOUT_SECS = 10;
export const DEFAULT_REQUEST_TIMEOUT_SECS = 30;
export const DEFAULT_HANDSHAKE_TIMEOUT_SECS = 5;
export const MAX_CONNECTION_POOL_SIZE = 10;
export const POOL_IDLE_TIMEOUT_SECS = 300;

export enum Method {
  Get = 'GET',
  Post = 'POST',
  Put = 'PUT',
  Delete = 'DELETE',
  Head = 'HEAD',
  Options = 'OPTIONS',
  Patch = 'PATCH',
  Handshake = 'HANDSHAKE',
}

export enum StatusCode {
  SwitchingProtocols = 101,
  Ok = 200,
  Created = 201,
  Accepted = 202,
  NoContent = 204,
  BadRequest = 400,
  Unauthorized = 401,
  Forbidden = 403,
  NotFound = 404,
  MethodNotAllowed = 405,
  Timeout = 408,
  TooLarge = 413,
  UnsupportedMediaType = 415,
  InternalServerError = 500,
  NotImplemented = 501,
  BadGateway = 502,
  ServiceUnavailable = 503,
  GatewayTimeout = 504,
}

function statusReason(code: StatusCode): string {
  switch (code) {
    case StatusCode.SwitchingProtocols:
      return 'SWITCHING_PROTOCOLS';
    case StatusCode.Ok:
      return 'OK';
    default:
      return 'UNKNOWN';
  }
}

// Minimal buffered reader for Node Duplex to support readExact and readUntilCRLF used by parser.
class BufferedReader {
  private socket: Duplex;
  private buf: Buffer = Buffer.alloc(0);
  private resolvers: Array<() => void> = [];

  constructor(socket: Duplex) {
    this.socket = socket;
    socket.on('data', (c: Buffer) => this.push(c));
    socket.on('end', () => this.push(Buffer.alloc(0)));
  }

  private push(chunk: Buffer) {
    if (chunk.length > 0) this.buf = Buffer.concat([this.buf, chunk]);
    for (const r of this.resolvers.splice(0)) r();
  }

  private async waitFor(predicate: () => boolean): Promise<void> {
    if (predicate()) return;
    await new Promise<void>((resolve) => this.resolvers.push(resolve));
    return this.waitFor(predicate);
  }

  async readExact(n: number): Promise<Buffer> {
    await this.waitFor(() => this.buf.length >= n || this.buf.length === 0 && this.socket.readableEnded);
    if (this.buf.length < n) throw new Error('Unexpected EOF');
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  async readUntilCRLF(): Promise<Buffer> {
    const idx = () => {
      for (let i = 0; i + 1 < this.buf.length; i++) if (this.buf[i] === 13 && this.buf[i + 1] === 10) return i;
      return -1;
    };
    await this.waitFor(() => idx() >= 0 || (this.buf.length === 0 && this.socket.readableEnded));
    const i = idx();
    if (i < 0) throw new Error('Unexpected EOF');
    const out = this.buf.slice(0, i + 2);
    this.buf = this.buf.slice(i + 2);
    return out;
  }

  // read up to n bytes, return available bytes (may be fewer)
  async readAvailable(n: number): Promise<Buffer> {
    if (this.buf.length === 0) {
      await this.waitFor(() => this.buf.length > 0 || this.socket.readableEnded);
    }
    const take = Math.min(n, this.buf.length);
    const out = this.buf.slice(0, take);
    this.buf = this.buf.slice(take);
    return out;
  }
}

export class GurtClient {
  private socket: Duplex;
  private reader: BufferedReader;

  // Create a new GurtClient with an initial socket (net.Socket or tls.TLSSocket)
  // See crates/yo-gurt/src/lib.rs for handshake and request formatting logic.
  constructor(socket: Duplex) {
    this.socket = socket;
    this.reader = new BufferedReader(socket);
  }

  // Replace the underlying socket at runtime. TLS can be applied externally and set here.
  // This implements the requirement that the socket is changeable on-the-fly.
  setSocket(socket: Duplex) {
    // NOTE: old socket listeners remain; callers should destroy/close the old socket if needed.
    this.socket = socket;
    this.reader = new BufferedReader(socket);
  }

  private writeAll(data: Buffer | string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ok = this.socket.write(data, (err) => (err ? reject(err) : resolve()));
      if (!ok) this.socket.once('drain', () => resolve());
    });
  }

  // Mandatory handshake per spec/crate: write HANDSHAKE request with CRLF terminated headers
  async handshake(host: string, userAgent: string): Promise<void> {
    await this.writeAll(`HANDSHAKE / ${GURT_VERSION}\r\n`);
    await this.writeAll(`host: ${host}\r\n`);
    await this.writeAll(`user-agent: ${userAgent}\r\n`);
    await this.writeAll('\r\n');
  }

  responseReader(): ResponseReader {
    return new ResponseReader(this.socket, this.reader);
  }

  async requestNoBody(method: Method, path: string, host: string, userAgent?: string): Promise<void> {
    const ua = userAgent ?? 'yo-gurt/0.1';
    await this.writeAll(`${method} ${path} ${GURT_VERSION}\r\n`);
    await this.writeAll(`host: ${host}\r\n`);
    await this.writeAll(`user-agent: ${ua}\r\n`);
    await this.writeAll('\r\n');
  }

  async requestWithBody(
    method: Method,
    path: string,
    host: string,
    contentLength: number,
    userAgent?: string,
    contentType?: string
  ): Promise<RequestBodyWriter> {
    const ua = userAgent ?? 'yo-gurt/0.1';
    await this.writeAll(`${method} ${path} ${GURT_VERSION}\r\n`);
    await this.writeAll(`host: ${host}\r\n`);
    if (contentType) await this.writeAll(`content-type: ${contentType}\r\n`);
    await this.writeAll(`content-length: ${contentLength}\r\n`);
    await this.writeAll(`user-agent: ${ua}\r\n`);
    await this.writeAll('\r\n');
    return new RequestBodyWriter(this.socket);
  }
}

export class RequestBodyWriter {
  private socket: Duplex;
  constructor(socket: Duplex) {
    this.socket = socket;
  }
  write(data: Buffer | string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ok = this.socket.write(data, (err) => (err ? reject(err) : resolve()));
      if (!ok) this.socket.once('drain', () => resolve());
    });
  }
  finish(): void {
    // no-op
  }
}

export type StatusLineResult = { status: StatusCode; bytesRead: number };
export type HeaderResult = { name: string; value: string; totalBytes: number };

export class ResponseReader {
  private socket: Duplex;
  private reader: BufferedReader;

  constructor(socket: Duplex, reader: BufferedReader) {
    this.socket = socket;
    this.reader = reader;
  }

  async readStatusLine(): Promise<StatusLineResult> {
    const buf = await this.reader.readUntilCRLF();
    const line = buf.slice(0, buf.length - 2).toString('ascii');
    const parts = line.split(' ');
    if (parts[0] !== GURT_VERSION) throw new Error('Invalid protocol');
    const code = parseInt(parts[1], 10);
    if (Number.isNaN(code)) throw new Error('Invalid status code');
    return { status: code as unknown as StatusCode, bytesRead: buf.length };
  }

  async readHeader(): Promise<HeaderResult | null> {
    const buf = await this.reader.readUntilCRLF();
    if (buf.length === 2) return null; // end of headers
    const line = buf.slice(0, buf.length - 2).toString('ascii');
    const idx = line.indexOf(':');
    if (idx < 0) throw new Error('Invalid header');
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    return { name, value, totalBytes: buf.length };
  }

  async readBody(buf: Buffer): Promise<number> {
    const data = await this.reader.readAvailable(buf.length);
    data.copy(buf, 0);
    return data.length;
  }

  async readBodyExact(buf: Buffer): Promise<void> {
    const data = await this.reader.readExact(buf.length);
    data.copy(buf, 0);
  }
}

/*
Citations:
- crates/yo-gurt/src/lib.rs: implementation structure, constants, parsing logic, handshake and request formatting.
- crates/yo-gurt/README.md: protocol requirements (HANDSHAKE required, TLS 1.3, lowercase headers, CRLF endings).
*/
