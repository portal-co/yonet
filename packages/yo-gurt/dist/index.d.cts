export declare const GURT_VERSION = "GURT/1.0.0";
export declare const DEFAULT_PORT = 4878;
export declare const ALPN_IDENTIFIER = "GURT/1.0";
export declare const MAX_MESSAGE_SIZE: number;
export declare const DEFAULT_CONNECTION_TIMEOUT_SECS = 10;
export declare const DEFAULT_REQUEST_TIMEOUT_SECS = 30;
export declare const DEFAULT_HANDSHAKE_TIMEOUT_SECS = 5;
export declare const MAX_CONNECTION_POOL_SIZE = 10;
export declare const POOL_IDLE_TIMEOUT_SECS = 300;
export declare const Method: {
    readonly Get: "GET";
    readonly Post: "POST";
    readonly Put: "PUT";
    readonly Delete: "DELETE";
    readonly Head: "HEAD";
    readonly Options: "OPTIONS";
    readonly Patch: "PATCH";
    readonly Handshake: "HANDSHAKE";
};
export type Method = (typeof Method)[keyof typeof Method];
export declare const StatusCode: {
    readonly SwitchingProtocols: 101;
    readonly Ok: 200;
    readonly Created: 201;
    readonly Accepted: 202;
    readonly NoContent: 204;
    readonly BadRequest: 400;
    readonly Unauthorized: 401;
    readonly Forbidden: 403;
    readonly NotFound: 404;
    readonly MethodNotAllowed: 405;
    readonly Timeout: 408;
    readonly TooLarge: 413;
    readonly UnsupportedMediaType: 415;
    readonly InternalServerError: 500;
    readonly NotImplemented: 501;
    readonly BadGateway: 502;
    readonly ServiceUnavailable: 503;
    readonly GatewayTimeout: 504;
};
export type StatusCode = (typeof StatusCode)[keyof typeof StatusCode];
export type WebTransport = {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
};
declare class BufferedReader {
    #private;
    constructor(readable: ReadableStream<Uint8Array>);
    readExact(n: number): Promise<Uint8Array>;
    readUntilCRLF(): Promise<Uint8Array>;
    readAvailable(n: number): Promise<Uint8Array>;
}
declare class StreamWriter {
    #private;
    constructor(writable: WritableStream<Uint8Array>);
    write(data: Uint8Array | string): Promise<void>;
    close(): Promise<void>;
}
export declare class GurtClient {
    #private;
    constructor(transport: WebTransport);
    setTransport(transport: WebTransport): void;
    handshake(host: string, userAgent: string): Promise<void>;
    responseReader(): ResponseReader;
    requestNoBody(method: Method, path: string, host: string, userAgent?: string): Promise<void>;
    requestWithBody(method: Method, path: string, host: string, contentLength: number, userAgent?: string, contentType?: string): Promise<RequestBodyWriter>;
}
export declare class RequestBodyWriter {
    #private;
    constructor(writer: StreamWriter);
    write(data: Uint8Array | string): Promise<void>;
    finish(): Promise<void>;
}
export type StatusLineResult = {
    status: StatusCode;
    bytesRead: number;
};
export type HeaderResult = {
    name: string;
    value: string;
    totalBytes: number;
};
export declare class ResponseReader {
    #private;
    constructor(reader: BufferedReader);
    readStatusLine(): Promise<StatusLineResult>;
    readHeader(): Promise<HeaderResult | null>;
    readBody(target: Uint8Array): Promise<number>;
    readBodyExact(target: Uint8Array): Promise<void>;
}
export {};
