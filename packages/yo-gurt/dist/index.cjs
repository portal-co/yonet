"use strict";
/*
 * Web-compatible TypeScript implementation of the GURT protocol (v1.0.0).
 * Based on the Rust crate at: crates/yo-gurt/src/lib.rs
 * and documentation: crates/yo-gurt/README.md
 * Specification: https://github.com/outpoot/gurted/blob/main/docs/docs/gurt-protocol.md
 *
 * This file places inline citations so code can be cross-referenced with the Rust
 * implementation and the protocol specification.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResponseReader = exports.RequestBodyWriter = exports.GurtClient = exports.StatusCode = exports.Method = exports.POOL_IDLE_TIMEOUT_SECS = exports.MAX_CONNECTION_POOL_SIZE = exports.DEFAULT_HANDSHAKE_TIMEOUT_SECS = exports.DEFAULT_REQUEST_TIMEOUT_SECS = exports.DEFAULT_CONNECTION_TIMEOUT_SECS = exports.MAX_MESSAGE_SIZE = exports.ALPN_IDENTIFIER = exports.DEFAULT_PORT = exports.GURT_VERSION = void 0;
/* Citations (examples):
 * - crates/yo-gurt/src/lib.rs: see top-level docs and constants (GURT_VERSION, DEFAULT_PORT, ALPN_IDENTIFIER)
 * - crates/yo-gurt/src/lib.rs: Method and StatusCode enums, handshake and request formatting
 * - crates/yo-gurt/README.md: protocol requirements (HANDSHAKE, TLS 1.3 requirement, lowercase headers, CRLF)
 */
exports.GURT_VERSION = 'GURT/1.0.0';
// From crates/yo-gurt/src/lib.rs: "GURT Protocol version constant"
exports.DEFAULT_PORT = 4878; // From README: Default port: 4878
exports.ALPN_IDENTIFIER = 'GURT/1.0'; // From README: ALPN identifier: `GURT/1.0`
exports.MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10 MB (README/protocol limits)
exports.DEFAULT_CONNECTION_TIMEOUT_SECS = 10; // README
exports.DEFAULT_REQUEST_TIMEOUT_SECS = 30; // README
exports.DEFAULT_HANDSHAKE_TIMEOUT_SECS = 5; // README
exports.MAX_CONNECTION_POOL_SIZE = 10; // README
exports.POOL_IDLE_TIMEOUT_SECS = 300; // README
exports.Method = {
    // See crates/yo-gurt/src/lib.rs Method enum (lines describing HTTP-like methods)
    Get: 'GET',
    Post: 'POST',
    Put: 'PUT',
    Delete: 'DELETE',
    Head: 'HEAD',
    Options: 'OPTIONS',
    Patch: 'PATCH',
    Handshake: 'HANDSHAKE', // Spec: Every GURT session must begin with a HANDSHAKE request
};
exports.StatusCode = {
    // See crates/yo-gurt/src/lib.rs StatusCode enum (HTTP-compatible status codes)
    SwitchingProtocols: 101,
    Ok: 200,
    Created: 201,
    Accepted: 202,
    NoContent: 204,
    BadRequest: 400,
    Unauthorized: 401,
    Forbidden: 403,
    NotFound: 404,
    MethodNotAllowed: 405,
    Timeout: 408,
    TooLarge: 413,
    UnsupportedMediaType: 415,
    InternalServerError: 500,
    NotImplemented: 501,
    BadGateway: 502,
    ServiceUnavailable: 503,
    GatewayTimeout: 504,
};
function statusReason(code) {
    // Mirrors StatusCode::reason_phrase from crates/yo-gurt/src/lib.rs
    switch (code) {
        case exports.StatusCode.SwitchingProtocols:
            return 'SWITCHING_PROTOCOLS';
        case exports.StatusCode.Ok:
            return 'OK';
        case exports.StatusCode.Created:
            return 'CREATED';
        case exports.StatusCode.Accepted:
            return 'ACCEPTED';
        case exports.StatusCode.NoContent:
            return 'NO_CONTENT';
        case exports.StatusCode.BadRequest:
            return 'BAD_REQUEST';
        case exports.StatusCode.Unauthorized:
            return 'UNAUTHORIZED';
        case exports.StatusCode.Forbidden:
            return 'FORBIDDEN';
        case exports.StatusCode.NotFound:
            return 'NOT_FOUND';
        case exports.StatusCode.MethodNotAllowed:
            return 'METHOD_NOT_ALLOWED';
        case exports.StatusCode.Timeout:
            return 'TIMEOUT';
        case exports.StatusCode.TooLarge:
            return 'TOO_LARGE';
        case exports.StatusCode.UnsupportedMediaType:
            return 'UNSUPPORTED_MEDIA_TYPE';
        case exports.StatusCode.InternalServerError:
            return 'INTERNAL_SERVER_ERROR';
        case exports.StatusCode.NotImplemented:
            return 'NOT_IMPLEMENTED';
        case exports.StatusCode.BadGateway:
            return 'BAD_GATEWAY';
        case exports.StatusCode.ServiceUnavailable:
            return 'SERVICE_UNAVAILABLE';
        case exports.StatusCode.GatewayTimeout:
            return 'GATEWAY_TIMEOUT';
        default:
            return 'UNKNOWN';
    }
}
// BufferedReader adapted to web ReadableStream API (no Node.js dependency).
// Parsing behaviors and semantics follow crates/yo-gurt/src/lib.rs ResponseReader logic.
class BufferedReader {
    #reader;
    #buf = new Uint8Array(0);
    #done = false;
    constructor(readable) {
        this.#reader = readable.getReader();
    }
    #append(chunk) {
        const out = new Uint8Array(this.#buf.length + chunk.length);
        out.set(this.#buf, 0);
        out.set(chunk, this.#buf.length);
        this.#buf = out;
    }
    #indexOfCRLF() {
        const b = this.#buf;
        for (let i = 0; i + 1 < b.length; i++) {
            if (b[i] === 0x0d && b[i + 1] === 0x0a)
                return i;
        }
        return -1;
    }
    async #pullOne() {
        if (this.#done)
            return;
        const { value, done } = await this.#reader.read();
        if (done) {
            this.#done = true;
            return;
        }
        if (value)
            this.#append(value);
    }
    // Read exactly n bytes or throw if EOF
    async readExact(n) {
        while (this.#buf.length < n && !this.#done)
            await this.#pullOne();
        if (this.#buf.length < n)
            throw new Error('Unexpected EOF');
        const out = this.#buf.slice(0, n);
        this.#buf = this.#buf.slice(n);
        return out;
    }
    // Read until CRLF (returns buffer including CRLF)
    async readUntilCRLF() {
        while (this.#indexOfCRLF() < 0 && !this.#done)
            await this.#pullOne();
        const idx = this.#indexOfCRLF();
        if (idx < 0)
            throw new Error('Unexpected EOF');
        const out = this.#buf.slice(0, idx + 2);
        this.#buf = this.#buf.slice(idx + 2);
        return out;
    }
    // Read up to n bytes available (may return fewer)
    async readAvailable(n) {
        if (this.#buf.length === 0 && !this.#done)
            await this.#pullOne();
        const take = Math.min(n, this.#buf.length);
        const out = this.#buf.slice(0, take);
        this.#buf = this.#buf.slice(take);
        return out;
    }
}
// Writer wrapper for WritableStream
class StreamWriter {
    #writer;
    #encoder = new TextEncoder();
    constructor(writable) {
        this.#writer = writable.getWriter();
    }
    async write(data) {
        const chunk = typeof data === 'string' ? this.#encoder.encode(data) : data;
        await this.#writer.write(chunk);
    }
    async close() {
        await this.#writer.close();
    }
}
// GurtClient using WebTransport. Socket (transport) can be swapped at runtime via setTransport().
class GurtClient {
    #transport;
    #reader;
    #writer;
    // Create a new client with an initial web transport (ReadableStream/WritableStream).
    // Citation: request formatting and handshake follow crates/yo-gurt/src/lib.rs
    constructor(transport) {
        this.#transport = transport;
        this.#reader = new BufferedReader(transport.readable);
        this.#writer = new StreamWriter(transport.writable);
    }
    // Replace the underlying transport at runtime so TLS can be applied and swapped in.
    // Mirrors requirement: "socket is changeable on-the-fly (TLS will be added at runtime)".
    setTransport(transport) {
        // Callers are responsible for closing old transport if needed.
        this.#transport = transport;
        this.#reader = new BufferedReader(transport.readable);
        this.#writer = new StreamWriter(transport.writable);
    }
    async #writeAll(data) {
        await this.#writer.write(data);
    }
    // Handshake: every GURT session must begin with a HANDSHAKE request per spec/README.
    async handshake(host, userAgent) {
        // From crates/yo-gurt/src/lib.rs: handshake writes method line and host/user-agent headers
        await this.#writeAll(`HANDSHAKE / ${exports.GURT_VERSION}\r\n`);
        await this.#writeAll(`host: ${host}\r\n`);
        await this.#writeAll(`user-agent: ${userAgent}\r\n`);
        await this.#writeAll('\r\n'); // header terminator
    }
    responseReader() {
        return new ResponseReader(this.#reader);
    }
    // Send a request without body
    async requestNoBody(method, path, host, userAgent) {
        const ua = userAgent ?? 'yo-gurt/0.1';
        await this.#writeAll(`${method} ${path} ${exports.GURT_VERSION}\r\n`);
        await this.#writeAll(`host: ${host}\r\n`);
        await this.#writeAll(`user-agent: ${ua}\r\n`);
        await this.#writeAll('\r\n');
    }
    // Start a request with a body; returns a writer to stream body data.
    async requestWithBody(method, path, host, contentLength, userAgent, contentType) {
        const ua = userAgent ?? 'yo-gurt/0.1';
        await this.#writeAll(`${method} ${path} ${exports.GURT_VERSION}\r\n`);
        await this.#writeAll(`host: ${host}\r\n`);
        if (contentType)
            await this.#writeAll(`content-type: ${contentType}\r\n`);
        await this.#writeAll(`content-length: ${contentLength}\r\n`);
        await this.#writeAll(`user-agent: ${ua}\r\n`);
        await this.#writeAll('\r\n');
        return new RequestBodyWriter(this.#writer);
    }
}
exports.GurtClient = GurtClient;
class RequestBodyWriter {
    #writer;
    constructor(writer) {
        this.#writer = writer;
    }
    async write(data) {
        await this.#writer.write(data);
    }
    async finish() {
        // no-op: keep connection open; closing may be handled by caller
    }
}
exports.RequestBodyWriter = RequestBodyWriter;
// ResponseReader parses status line, headers, and exposes body read helpers.
class ResponseReader {
    #reader;
    #decoder = new TextDecoder('utf-8');
    constructor(reader) {
        this.#reader = reader;
    }
    // Read status line: "GURT/1.0.0 <code> <message>\r\n"
    async readStatusLine() {
        const buf = await this.#reader.readUntilCRLF();
        const line = this.#decoder.decode(buf.subarray(0, buf.length - 2));
        const parts = line.split(' ');
        if (parts[0] !== exports.GURT_VERSION)
            throw new Error('Invalid protocol');
        const code = parseInt(parts[1], 10);
        if (Number.isNaN(code))
            throw new Error('Invalid status code');
        return { status: code, bytesRead: buf.length };
    }
    // Read a header line. Return null when encountering the empty line that terminates headers.
    async readHeader() {
        const buf = await this.#reader.readUntilCRLF();
        if (buf.length === 2)
            return null; // \r\n only
        const line = this.#decoder.decode(buf.subarray(0, buf.length - 2));
        const idx = line.indexOf(':');
        if (idx < 0)
            throw new Error('Invalid header');
        const name = line.slice(0, idx).trim().toLowerCase(); // spec: lowercase header names
        const value = line.slice(idx + 1).trim();
        return { name, value, totalBytes: buf.length };
    }
    // Read up to buf.length bytes and write into provided Uint8Array, returning bytes read.
    async readBody(target) {
        const data = await this.#reader.readAvailable(target.length);
        target.set(data, 0);
        return data.length;
    }
    // Read exact amount into buffer or throw on EOF.
    async readBodyExact(target) {
        const data = await this.#reader.readExact(target.length);
        target.set(data, 0);
    }
}
exports.ResponseReader = ResponseReader;
/*
Notes/Citations inline:
- Handshake and request formatting: see crates/yo-gurt/src/lib.rs functions handshake(), request_no_body(), request_with_body() for exact CRLF placement and header order.
- Response parsing (status line, headers): see ResponseReader implementation in crates/yo-gurt/src/lib.rs for parsing strategy.
- Protocol requirements: crates/yo-gurt/README.md (HANDSHAKE required, TLS 1.3 for all connections, lowercase headers, CRLF endings).
*/ 
