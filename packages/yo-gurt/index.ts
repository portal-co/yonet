/*
 * Web-compatible TypeScript implementation of the GURT protocol (v1.0.0).
 * Based on the Rust crate at: crates/yo-gurt/src/lib.rs
 * and documentation: crates/yo-gurt/README.md
 * Specification: https://github.com/outpoot/gurted/blob/main/docs/docs/gurt-protocol.md
 *
 * This file places inline citations so code can be cross-referenced with the Rust
 * implementation and the protocol specification.
 */

/* Citations (examples):
 * - crates/yo-gurt/src/lib.rs: see top-level docs and constants (GURT_VERSION, DEFAULT_PORT, ALPN_IDENTIFIER)
 * - crates/yo-gurt/src/lib.rs: Method and StatusCode enums, handshake and request formatting
 * - crates/yo-gurt/README.md: protocol requirements (HANDSHAKE, TLS 1.3 requirement, lowercase headers, CRLF)
 */

export const GURT_VERSION = 'GURT/1.0.0';
// From crates/yo-gurt/src/lib.rs: "GURT Protocol version constant"
export const DEFAULT_PORT = 4878; // From README: Default port: 4878
export const ALPN_IDENTIFIER = 'GURT/1.0'; // From README: ALPN identifier: `GURT/1.0`
export const MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10 MB (README/protocol limits)
export const DEFAULT_CONNECTION_TIMEOUT_SECS = 10; // README
export const DEFAULT_REQUEST_TIMEOUT_SECS = 30; // README
export const DEFAULT_HANDSHAKE_TIMEOUT_SECS = 5; // README
export const MAX_CONNECTION_POOL_SIZE = 10; // README
export const POOL_IDLE_TIMEOUT_SECS = 300; // README

export enum Method {
  // See crates/yo-gurt/src/lib.rs Method enum (lines describing HTTP-like methods)
  Get = 'GET',
  Post = 'POST',
  Put = 'PUT',
  Delete = 'DELETE',
  Head = 'HEAD',
  Options = 'OPTIONS',
  Patch = 'PATCH',
  Handshake = 'HANDSHAKE', // Spec: Every GURT session must begin with a HANDSHAKE request
}

export enum StatusCode {
  // See crates/yo-gurt/src/lib.rs StatusCode enum (HTTP-compatible status codes)
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
  // Mirrors StatusCode::reason_phrase from crates/yo-gurt/src/lib.rs
  switch (code) {
    case StatusCode.SwitchingProtocols:
      return 'SWITCHING_PROTOCOLS';
    case StatusCode.Ok:
      return 'OK';
    default:
      return 'UNKNOWN';
  }
}

// Transport type for web streams: a pair of ReadableStream and WritableStream.
export type WebTransport = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

// BufferedReader adapted to web ReadableStream API (no Node.js dependency).
// Parsing behaviors and semantics follow crates/yo-gurt/src/lib.rs ResponseReader logic.
class BufferedReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buf: Uint8Array = new Uint8Array(0);
  #done = false;

  constructor(readable: ReadableStream<Uint8Array>) {
    this.#reader = readable.getReader();
  }

  #append(chunk: Uint8Array) {
    const out = new Uint8Array(this.#buf.length + chunk.length);
    out.set(this.#buf, 0);
    out.set(chunk, this.#buf.length);
    this.#buf = out;
  }

  #indexOfCRLF(): number {
    const b = this.#buf;
    for (let i = 0; i + 1 < b.length; i++) {
      if (b[i] === 0x0d && b[i + 1] === 0x0a) return i;
    }
    return -1;
  }

  async #pullOne(): Promise<void> {
    if (this.#done) return;
    const { value, done } = await this.#reader.read();
    if (done) {
      this.#done = true;
      return;
    }
    if (value) this.#append(value);
  }

  // Read exactly n bytes or throw if EOF
  async readExact(n: number): Promise<Uint8Array> {
    while (this.#buf.length < n && !this.#done) await this.#pullOne();
    if (this.#buf.length < n) throw new Error('Unexpected EOF');
    const out = this.#buf.slice(0, n);
    this.#buf = this.#buf.slice(n);
    return out;
  }

  // Read until CRLF (returns buffer including CRLF)
  async readUntilCRLF(): Promise<Uint8Array> {
    while (this.#indexOfCRLF() < 0 && !this.#done) await this.#pullOne();
    const idx = this.#indexOfCRLF();
    if (idx < 0) throw new Error('Unexpected EOF');
    const out = this.#buf.slice(0, idx + 2);
    this.#buf = this.#buf.slice(idx + 2);
    return out;
  }

  // Read up to n bytes available (may return fewer)
  async readAvailable(n: number): Promise<Uint8Array> {
    if (this.#buf.length === 0 && !this.#done) await this.#pullOne();
    const take = Math.min(n, this.#buf.length);
    const out = this.#buf.slice(0, take);
    this.#buf = this.#buf.slice(take);
    return out;
  }
}

// Writer wrapper for WritableStream
class StreamWriter {
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #encoder = new TextEncoder();

  constructor(writable: WritableStream<Uint8Array>) {
    this.#writer = writable.getWriter();
  }

  async write(data: Uint8Array | string): Promise<void> {
    const chunk = typeof data === 'string' ? this.#encoder.encode(data) : data;
    await this.#writer.write(chunk);
  }

  async close(): Promise<void> {
    await this.#writer.close();
  }
}

// GurtClient using WebTransport. Socket (transport) can be swapped at runtime via setTransport().
export class GurtClient {
  #transport: WebTransport;
  #reader: BufferedReader;
  #writer: StreamWriter;

  // Create a new client with an initial web transport (ReadableStream/WritableStream).
  // Citation: request formatting and handshake follow crates/yo-gurt/src/lib.rs
  constructor(transport: WebTransport) {
    this.#transport = transport;
    this.#reader = new BufferedReader(transport.readable);
    this.#writer = new StreamWriter(transport.writable);
  }

  // Replace the underlying transport at runtime so TLS can be applied and swapped in.
  // Mirrors requirement: "socket is changeable on-the-fly (TLS will be added at runtime)".
  setTransport(transport: WebTransport) {
    // Callers are responsible for closing old transport if needed.
    this.#transport = transport;
    this.#reader = new BufferedReader(transport.readable);
    this.#writer = new StreamWriter(transport.writable);
  }

  async #writeAll(data: string | Uint8Array): Promise<void> {
    await this.#writer.write(data);
  }

  // Handshake: every GURT session must begin with a HANDSHAKE request per spec/README.
  async handshake(host: string, userAgent: string): Promise<void> {
    // From crates/yo-gurt/src/lib.rs: handshake writes method line and host/user-agent headers
    await this.#writeAll(`HANDSHAKE / ${GURT_VERSION}\r\n`);
    await this.#writeAll(`host: ${host}\r\n`);
    await this.#writeAll(`user-agent: ${userAgent}\r\n`);
    await this.#writeAll('\r\n'); // header terminator
  }

  responseReader(): ResponseReader {
    return new ResponseReader(this.#reader);
  }

  // Send a request without body
  async requestNoBody(method: Method, path: string, host: string, userAgent?: string): Promise<void> {
    const ua = userAgent ?? 'yo-gurt/0.1';
    await this.#writeAll(`${method} ${path} ${GURT_VERSION}\r\n`);
    await this.#writeAll(`host: ${host}\r\n`);
    await this.#writeAll(`user-agent: ${ua}\r\n`);
    await this.#writeAll('\r\n');
  }

  // Start a request with a body; returns a writer to stream body data.
  async requestWithBody(
    method: Method,
    path: string,
    host: string,
    contentLength: number,
    userAgent?: string,
    contentType?: string
  ): Promise<RequestBodyWriter> {
    const ua = userAgent ?? 'yo-gurt/0.1';
    await this.#writeAll(`${method} ${path} ${GURT_VERSION}\r\n`);
    await this.#writeAll(`host: ${host}\r\n`);
    if (contentType) await this.#writeAll(`content-type: ${contentType}\r\n`);
    await this.#writeAll(`content-length: ${contentLength}\r\n`);
    await this.#writeAll(`user-agent: ${ua}\r\n`);
    await this.#writeAll('\r\n');
    return new RequestBodyWriter(this.#writer);
  }
}

export class RequestBodyWriter {
  #writer: StreamWriter;
  constructor(writer: StreamWriter) {
    this.#writer = writer;
  }
  async write(data: Uint8Array | string): Promise<void> {
    await this.#writer.write(data);
  }
  async finish(): Promise<void> {
    // no-op: keep connection open; closing may be handled by caller
  }
}

export type StatusLineResult = { status: StatusCode; bytesRead: number };
export type HeaderResult = { name: string; value: string; totalBytes: number };

// ResponseReader parses status line, headers, and exposes body read helpers.
export class ResponseReader {
  #reader: BufferedReader;
  #decoder = new TextDecoder('utf-8');

  constructor(reader: BufferedReader) {
    this.#reader = reader;
  }

  // Read status line: "GURT/1.0.0 <code> <message>\r\n"
  async readStatusLine(): Promise<StatusLineResult> {
    const buf = await this.#reader.readUntilCRLF();
    const line = this.#decoder.decode(buf.subarray(0, buf.length - 2));
    const parts = line.split(' ');
    if (parts[0] !== GURT_VERSION) throw new Error('Invalid protocol');
    const code = parseInt(parts[1], 10);
    if (Number.isNaN(code)) throw new Error('Invalid status code');
    return { status: code as unknown as StatusCode, bytesRead: buf.length };
  }

  // Read a header line. Return null when encountering the empty line that terminates headers.
  async readHeader(): Promise<HeaderResult | null> {
    const buf = await this.#reader.readUntilCRLF();
    if (buf.length === 2) return null; // \r\n only
    const line = this.#decoder.decode(buf.subarray(0, buf.length - 2));
    const idx = line.indexOf(':');
    if (idx < 0) throw new Error('Invalid header');
    const name = line.slice(0, idx).trim().toLowerCase(); // spec: lowercase header names
    const value = line.slice(idx + 1).trim();
    return { name, value, totalBytes: buf.length };
  }

  // Read up to buf.length bytes and write into provided Uint8Array, returning bytes read.
  async readBody(target: Uint8Array): Promise<number> {
    const data = await this.#reader.readAvailable(target.length);
    target.set(data, 0);
    return data.length;
  }

  // Read exact amount into buffer or throw on EOF.
  async readBodyExact(target: Uint8Array): Promise<void> {
    const data = await this.#reader.readExact(target.length);
    target.set(data, 0);
  }
}

/*
Notes/Citations inline:
- Handshake and request formatting: see crates/yo-gurt/src/lib.rs functions handshake(), request_no_body(), request_with_body() for exact CRLF placement and header order.
- Response parsing (status line, headers): see ResponseReader implementation in crates/yo-gurt/src/lib.rs for parsing strategy.
- Protocol requirements: crates/yo-gurt/README.md (HANDSHAKE required, TLS 1.3 for all connections, lowercase headers, CRLF endings).
*/