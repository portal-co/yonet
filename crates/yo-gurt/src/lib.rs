//! GURT Protocol Implementation (v1.0.0)
//!
//! This crate implements the GURT (version 1.0.0) protocol, a TCP-based application protocol
//! designed as an HTTP-like alternative with built-in TLS 1.3 encryption.
//!
//! Based on specification from:
//! https://github.com/outpoot/gurted/blob/main/docs/docs/gurt-protocol.md
//!
//! ## Overview
//!
//! From the spec: "GURT (version 1.0.0) is a TCP-based application protocol designed as an
//! HTTP-like alternative with built-in TLS 1.3 encryption. It serves as the foundation for
//! the Gurted ecosystem, enabling secure communication between clients and servers using
//! the `gurt://` URL scheme."
//!
//! ## Key Features
//!
//! - HTTP-like syntax with familiar methods (GET, POST, PUT, DELETE, etc.)
//! - Built-in required TLS 1.3 encryption for all connections
//! - Binary and text data support
//! - Status codes compatible with HTTP semantics
//! - Default port: 4878
//! - ALPN identifier: `GURT/1.0`
//!
//! ## Usage Example
//!
//! ```rust,ignore
//! use portal_solutions_yo_gurt::{GurtClient, Method, StatusCode};
//!
//! // Create a GURT client with your TLS transport
//! let mut client = GurtClient::new(transport);
//!
//! // Perform handshake (required by spec)
//! client.handshake("example.com", "yo-gurt/0.1").await?;
//!
//! // Read handshake response
//! let mut response = client.response_reader();
//! let mut buf = [0u8; 512];
//! let (status, _) = response.read_status_line(&mut buf).await?;
//! assert_eq!(status, StatusCode::SwitchingProtocols);
//!
//! // Skip headers until end
//! while response.read_header(&mut buf).await?.is_some() {}
//!
//! // Make a GET request
//! client.request_no_body(Method::Get, "/api/data", "example.com", None).await?;
//!
//! // Read response status
//! let mut response = client.response_reader();
//! let (status, _) = response.read_status_line(&mut buf).await?;
//! ```

#![no_std]

use embedded_io_async::{Read, ReadExactError, Write};

/// GURT Protocol version constant
/// From spec: "GURT (version 1.0.0)"
pub const GURT_VERSION: &str = "GURT/1.0.0";

/// Default GURT port
/// From spec: "Default port: 4878"
pub const DEFAULT_PORT: u16 = 4878;

/// ALPN identifier for TLS negotiation
/// From spec: "ALPN identifier: `GURT/1.0`"
pub const ALPN_IDENTIFIER: &str = "GURT/1.0";

/// Protocol Limits
///
/// From spec: "Protocol Limits" section
///
/// Maximum message size
/// From spec: "Maximum message size: 10 MB"
pub const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024; // 10 MB

/// Default connection timeout in seconds
/// From spec: "Default connection timeout: 10 seconds"
pub const DEFAULT_CONNECTION_TIMEOUT_SECS: u32 = 10;

/// Default request timeout in seconds
/// From spec: "Default request timeout: 30 seconds"
pub const DEFAULT_REQUEST_TIMEOUT_SECS: u32 = 30;

/// Default handshake timeout in seconds
/// From spec: "Default handshake timeout: 5 seconds"
pub const DEFAULT_HANDSHAKE_TIMEOUT_SECS: u32 = 5;

/// Maximum connection pool size
/// From spec: "Maximum connection pool size: 10 connections"
pub const MAX_CONNECTION_POOL_SIZE: usize = 10;

/// Pool idle timeout in seconds
/// From spec: "Pool idle timeout: 300 seconds"
pub const POOL_IDLE_TIMEOUT_SECS: u32 = 300;

/// HTTP Methods supported by GURT
///
/// From spec: "GURT supports all standard HTTP methods"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// Retrieve resource (no body allowed)
    Get,
    /// Create/submit data (body allowed)
    Post,
    /// Update/replace resource (body allowed)
    Put,
    /// Remove resource (no body allowed)
    Delete,
    /// Get headers only (no body allowed)
    Head,
    /// Get allowed methods (no body allowed)
    Options,
    /// Partial update (body allowed)
    Patch,
    /// Protocol handshake (no body allowed)
    /// From spec: "Every GURT session must begin with a `HANDSHAKE` request"
    Handshake,
}

impl Method {
    /// Returns the string representation of the method
    pub const fn as_str(&self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Delete => "DELETE",
            Method::Head => "HEAD",
            Method::Options => "OPTIONS",
            Method::Patch => "PATCH",
            Method::Handshake => "HANDSHAKE",
        }
    }

    /// Parse method from bytes
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        match bytes {
            b"GET" => Some(Method::Get),
            b"POST" => Some(Method::Post),
            b"PUT" => Some(Method::Put),
            b"DELETE" => Some(Method::Delete),
            b"HEAD" => Some(Method::Head),
            b"OPTIONS" => Some(Method::Options),
            b"PATCH" => Some(Method::Patch),
            b"HANDSHAKE" => Some(Method::Handshake),
            _ => None,
        }
    }
}

/// GURT Status Codes
///
/// From spec: "GURT uses HTTP-compatible status codes"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusCode {
    // Protocol (1xx)
    /// From spec: "101 SWITCHING_PROTOCOLS - Handshake successful"
    SwitchingProtocols = 101,

    // Success (2xx)
    /// From spec: "200 OK - Request successful"
    Ok = 200,
    /// From spec: "201 CREATED - Resource created"
    Created = 201,
    /// From spec: "202 ACCEPTED - Request accepted for processing"
    Accepted = 202,
    /// From spec: "204 NO_CONTENT - Success with no response body"
    NoContent = 204,

    // Client Error (4xx)
    /// From spec: "400 BAD_REQUEST - Invalid request format"
    BadRequest = 400,
    /// From spec: "401 UNAUTHORIZED - Authentication required"
    Unauthorized = 401,
    /// From spec: "403 FORBIDDEN - Access denied"
    Forbidden = 403,
    /// From spec: "404 NOT_FOUND - Resource not found"
    NotFound = 404,
    /// From spec: "405 METHOD_NOT_ALLOWED - Method not supported"
    MethodNotAllowed = 405,
    /// From spec: "408 TIMEOUT - Request timeout"
    Timeout = 408,
    /// From spec: "413 TOO_LARGE - Request too large"
    TooLarge = 413,
    /// From spec: "415 UNSUPPORTED_MEDIA_TYPE - Unsupported content type"
    UnsupportedMediaType = 415,

    // Server Error (5xx)
    /// From spec: "500 INTERNAL_SERVER_ERROR - Server error"
    InternalServerError = 500,
    /// From spec: "501 NOT_IMPLEMENTED - Method not implemented"
    NotImplemented = 501,
    /// From spec: "502 BAD_GATEWAY - Gateway error"
    BadGateway = 502,
    /// From spec: "503 SERVICE_UNAVAILABLE - Service unavailable"
    ServiceUnavailable = 503,
    /// From spec: "504 GATEWAY_TIMEOUT - Gateway timeout"
    GatewayTimeout = 504,
}

impl StatusCode {
    /// Get status code as u16
    pub const fn as_u16(&self) -> u16 {
        *self as u16
    }

    /// Get the reason phrase for this status code
    pub const fn reason_phrase(&self) -> &'static str {
        match self {
            StatusCode::SwitchingProtocols => "SWITCHING_PROTOCOLS",
            StatusCode::Ok => "OK",
            StatusCode::Created => "CREATED",
            StatusCode::Accepted => "ACCEPTED",
            StatusCode::NoContent => "NO_CONTENT",
            StatusCode::BadRequest => "BAD_REQUEST",
            StatusCode::Unauthorized => "UNAUTHORIZED",
            StatusCode::Forbidden => "FORBIDDEN",
            StatusCode::NotFound => "NOT_FOUND",
            StatusCode::MethodNotAllowed => "METHOD_NOT_ALLOWED",
            StatusCode::Timeout => "TIMEOUT",
            StatusCode::TooLarge => "TOO_LARGE",
            StatusCode::UnsupportedMediaType => "UNSUPPORTED_MEDIA_TYPE",
            StatusCode::InternalServerError => "INTERNAL_SERVER_ERROR",
            StatusCode::NotImplemented => "NOT_IMPLEMENTED",
            StatusCode::BadGateway => "BAD_GATEWAY",
            StatusCode::ServiceUnavailable => "SERVICE_UNAVAILABLE",
            StatusCode::GatewayTimeout => "GATEWAY_TIMEOUT",
        }
    }

    /// Parse status code from u16
    pub const fn from_u16(code: u16) -> Option<Self> {
        match code {
            101 => Some(StatusCode::SwitchingProtocols),
            200 => Some(StatusCode::Ok),
            201 => Some(StatusCode::Created),
            202 => Some(StatusCode::Accepted),
            204 => Some(StatusCode::NoContent),
            400 => Some(StatusCode::BadRequest),
            401 => Some(StatusCode::Unauthorized),
            403 => Some(StatusCode::Forbidden),
            404 => Some(StatusCode::NotFound),
            405 => Some(StatusCode::MethodNotAllowed),
            408 => Some(StatusCode::Timeout),
            413 => Some(StatusCode::TooLarge),
            415 => Some(StatusCode::UnsupportedMediaType),
            500 => Some(StatusCode::InternalServerError),
            501 => Some(StatusCode::NotImplemented),
            502 => Some(StatusCode::BadGateway),
            503 => Some(StatusCode::ServiceUnavailable),
            504 => Some(StatusCode::GatewayTimeout),
            _ => None,
        }
    }
}

/// Trait for writing GURT headers
///
/// From spec: "Headers: Lowercase names, colon-separated values"
pub trait HeaderWriter {
    /// Write a header with the given name and value
    /// Headers should be lowercase as per spec
    fn write_header(&mut self, name: &str, value: &str) -> impl core::future::Future<Output = ()>;
}

/// GURT Client for making requests
///
/// From spec: "GURT provides a familiar HTTP-like syntax while offering security through
/// mandatory TLS 1.3 encryption."
pub struct GurtClient<T> {
    pub transport: T,
}

impl<T: Read + Write> GurtClient<T> {
    /// Create a new GURT client with the given transport
    pub fn new(transport: T) -> Self {
        Self { transport }
    }

    /// Perform GURT handshake
    ///
    /// From spec: "Every GURT session must begin with a `HANDSHAKE` request:
    /// ```text
    /// HANDSHAKE / GURT/1.0.0\r\n
    /// host: example.com\r\n
    /// user-agent: GURT-Client/1.0.0\r\n
    /// \r\n
    /// ```"
    pub async fn handshake(&mut self, host: &str, user_agent: &str) -> Result<(), T::Error> {
        // From spec: "METHOD /path GURT/1.0.0\r\n"
        self.transport.write_all(b"HANDSHAKE / ").await?;
        self.transport.write_all(GURT_VERSION.as_bytes()).await?;
        self.transport.write_all(b"\r\n").await?;

        // From spec: "host: example.com\r\n"
        self.transport.write_all(b"host: ").await?;
        self.transport.write_all(host.as_bytes()).await?;
        self.transport.write_all(b"\r\n").await?;

        // From spec: "user-agent: GURT-Client/1.0.0\r\n"
        self.transport.write_all(b"user-agent: ").await?;
        self.transport.write_all(user_agent.as_bytes()).await?;
        self.transport.write_all(b"\r\n").await?;

        // From spec: "Header terminator: `\r\n\r\n`"
        self.transport.write_all(b"\r\n").await?;

        Ok(())
    }

    /// Get a response reader for reading server responses
    pub fn response_reader(&mut self) -> ResponseReader<'_, T> {
        ResponseReader::new(&mut self.transport)
    }

    /// Send a request without a body
    ///
    /// From spec: "Request Structure:
    /// ```text
    /// METHOD /path GURT/1.0.0\r\n
    /// header-name: header-value\r\n
    /// content-length: 123\r\n
    /// user-agent: GURT-Client/1.0.0\r\n
    /// \r\n
    /// [message body]
    /// ```"
    pub async fn request_no_body(
        &mut self,
        method: Method,
        path: &str,
        host: &str,
        user_agent: Option<&str>,
    ) -> Result<(), T::Error> {
        let user_agent = user_agent.unwrap_or("yo-gurt/0.1");

        // From spec: "Method line: `METHOD /path GURT/1.0.0`"
        self.transport.write_all(method.as_str().as_bytes()).await?;
        self.transport.write_all(b" ").await?;
        self.transport.write_all(path.as_bytes()).await?;
        self.transport.write_all(b" ").await?;
        self.transport.write_all(GURT_VERSION.as_bytes()).await?;
        self.transport.write_all(b"\r\n").await?;

        // From spec: "Headers: Lowercase names, colon-separated values"
        self.transport.write_all(b"host: ").await?;
        self.transport.write_all(host.as_bytes()).await?;
        self.transport.write_all(b"\r\n").await?;

        self.transport.write_all(b"user-agent: ").await?;
        self.transport.write_all(user_agent.as_bytes()).await?;
        self.transport.write_all(b"\r\n").await?;

        // From spec: "Header terminator: `\r\n\r\n`"
        self.transport.write_all(b"\r\n").await?;

        Ok(())
    }

    /// Start a request with a body
    ///
    /// This writes the request line and headers, allowing the caller to write the body
    /// Returns a RequestBodyWriter that can be used to write the body and finalize the request
    pub async fn request_with_body<'a>(
        &'a mut self,
        method: Method,
        path: &str,
        host: &str,
        user_agent: Option<&str>,
        content_type: Option<&str>,
        content_length: usize,
    ) -> Result<RequestBodyWriter<'a, T>, T::Error> {
        let user_agent = user_agent.unwrap_or("yo-gurt/0.1");

        // From spec: "Method line: `METHOD /path GURT/1.0.0`"
        self.transport.write_all(method.as_str().as_bytes()).await?;
        self.transport.write_all(b" ").await?;
        self.transport.write_all(path.as_bytes()).await?;
        self.transport.write_all(b" ").await?;
        self.transport.write_all(GURT_VERSION.as_bytes()).await?;
        self.transport.write_all(b"\r\n").await?;

        // Write headers
        self.transport.write_all(b"host: ").await?;
        self.transport.write_all(host.as_bytes()).await?;
        self.transport.write_all(b"\r\n").await?;

        if let Some(content_type) = content_type {
            self.transport.write_all(b"content-type: ").await?;
            self.transport.write_all(content_type.as_bytes()).await?;
            self.transport.write_all(b"\r\n").await?;
        }

        // From spec: "content-length: 123\r\n"
        self.transport.write_all(b"content-length: ").await?;
        self.write_usize(content_length).await?;
        self.transport.write_all(b"\r\n").await?;

        self.transport.write_all(b"user-agent: ").await?;
        self.transport.write_all(user_agent.as_bytes()).await?;
        self.transport.write_all(b"\r\n").await?;

        // From spec: "Header terminator: `\r\n\r\n`"
        self.transport.write_all(b"\r\n").await?;

        Ok(RequestBodyWriter {
            transport: &mut self.transport,
        })
    }

    /// Helper to write a usize as ASCII decimal
    async fn write_usize(&mut self, mut n: usize) -> Result<(), T::Error> {
        if n == 0 {
            self.transport.write_all(b"0").await?;
            return Ok(());
        }

        let mut buf = [0u8; 20]; // Enough for 64-bit usize
        let mut i = buf.len();

        while n > 0 {
            i -= 1;
            buf[i] = b'0' + (n % 10) as u8;
            n /= 10;
        }

        self.transport.write_all(&buf[i..]).await?;
        Ok(())
    }
}

/// Helper for writing request bodies
pub struct RequestBodyWriter<'a, T> {
    transport: &'a mut T,
}

impl<'a, T: Write> RequestBodyWriter<'a, T> {
    /// Write body data
    /// From spec: "[message body]"
    pub async fn write(&mut self, data: &[u8]) -> Result<(), T::Error> {
        self.transport.write_all(data).await
    }

    /// Consume the writer (body is complete)
    pub fn finish(self) {
        // Body is written, nothing else to do
    }
}

/// Response reader for parsing GURT responses
///
/// From spec: "Response Structure:
/// ```text
/// GURT/1.0.0 200 OK\r\n
/// content-type: application/json\r\n
/// content-length: 123\r\n
/// server: GURT/1.0.0\r\n
/// date: Wed, 01 Jan 2020 00:00:00 GMT\r\n
/// \r\n
/// [response body]
/// ```"
pub struct ResponseReader<'a, T> {
    transport: &'a mut T,
}

impl<'a, T: Read> ResponseReader<'a, T> {
    /// Create a new response reader
    pub fn new(transport: &'a mut T) -> Self {
        Self { transport }
    }

    /// Read response status line
    /// From spec: "Status line: `GURT/1.0.0 <code> <message>`"
    ///
    /// Returns (status_code, buffer_with_line_data, bytes_read)
    pub async fn read_status_line(
        &mut self,
        buf: &mut [u8],
    ) -> Result<(StatusCode, usize), ResponseError<T::Error>> {
        let mut pos = 0;

        // Read until we find \r\n
        loop {
            if pos >= buf.len() {
                return Err(ResponseError::BufferTooSmall);
            }

            self.transport
                .read_exact(&mut buf[pos..pos + 1])
                .await
                .map_err(|e| match e {
                    ReadExactError::UnexpectedEof => ResponseError::UnexpectedEof,
                    ReadExactError::Other(e) => ResponseError::Io(e),
                })?;

            if pos > 0 && buf[pos - 1] == b'\r' && buf[pos] == b'\n' {
                // Found end of line
                let line = &buf[..pos - 1]; // Exclude \r\n

                // Parse: "GURT/1.0.0 200 OK"
                let mut parts = line.split(|&b| b == b' ');

                // Verify protocol version
                if parts.next() != Some(GURT_VERSION.as_bytes()) {
                    return Err(ResponseError::InvalidProtocol);
                }

                // Parse status code
                let code_bytes = parts.next().ok_or(ResponseError::InvalidStatusLine)?;
                let code = parse_u16(code_bytes).ok_or(ResponseError::InvalidStatusLine)?;
                let status_code =
                    StatusCode::from_u16(code).ok_or(ResponseError::InvalidStatusLine)?;

                return Ok((status_code, pos + 1));
            }

            pos += 1;
        }
    }

    /// Read a single header line
    /// From spec: "header-name: header-value\r\n"
    ///
    /// Returns (name_len, value_start, value_len, total_bytes) or None if end of headers
    pub async fn read_header(
        &mut self,
        buf: &mut [u8],
    ) -> Result<Option<(usize, usize, usize, usize)>, ResponseError<T::Error>> {
        let mut pos = 0;

        // Read until we find \r\n
        loop {
            if pos >= buf.len() {
                return Err(ResponseError::BufferTooSmall);
            }

            self.transport
                .read_exact(&mut buf[pos..pos + 1])
                .await
                .map_err(|e| match e {
                    ReadExactError::UnexpectedEof => ResponseError::UnexpectedEof,
                    ReadExactError::Other(e) => ResponseError::Io(e),
                })?;

            if pos > 0 && buf[pos - 1] == b'\r' && buf[pos] == b'\n' {
                // Found end of line
                if pos == 1 {
                    // Empty line (just \r\n) means end of headers
                    return Ok(None);
                }

                let line = &buf[..pos - 1]; // Exclude \r\n

                // Parse "name: value"
                if let Some(colon_pos) = line.iter().position(|&b| b == b':') {
                    let name_len = colon_pos;
                    let value_start = colon_pos + 1;
                    // Skip leading space after colon
                    let value_start = if value_start < line.len() && line[value_start] == b' ' {
                        value_start + 1
                    } else {
                        value_start
                    };
                    let value_len = line.len() - value_start;

                    return Ok(Some((name_len, value_start, value_len, pos + 1)));
                } else {
                    return Err(ResponseError::InvalidHeader);
                }
            }

            pos += 1;
        }
    }

    /// Read response body
    /// From spec: "[response body]"
    pub async fn read_body(&mut self, buf: &mut [u8]) -> Result<usize, T::Error> {
        self.transport.read(buf).await
    }

    /// Read exact amount of body data
    pub async fn read_body_exact(
        &mut self,
        buf: &mut [u8],
    ) -> Result<(), ReadExactError<T::Error>> {
        self.transport.read_exact(buf).await
    }
}

/// Response parsing errors
#[derive(Debug)]
pub enum ResponseError<E> {
    /// IO error from transport
    Io(E),
    /// Unexpected end of file
    UnexpectedEof,
    /// Buffer too small for response
    BufferTooSmall,
    /// Invalid protocol version
    InvalidProtocol,
    /// Invalid status line
    InvalidStatusLine,
    /// Invalid header format
    InvalidHeader,
}

/// Parse a u16 from ASCII bytes
fn parse_u16(bytes: &[u8]) -> Option<u16> {
    let mut result = 0u16;
    for &b in bytes {
        if !b.is_ascii_digit() {
            return None;
        }
        result = result.checked_mul(10)?;
        result = result.checked_add((b - b'0') as u16)?;
    }
    Some(result)
}
