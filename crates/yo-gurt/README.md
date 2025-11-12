# yo-gurt

A `no_std`, no-alloc, safe Rust implementation of the GURT protocol (version 1.0.0).

## Overview

This crate implements the GURT (version 1.0.0) protocol, a TCP-based application protocol designed as an HTTP-like alternative with built-in TLS 1.3 encryption. GURT serves as the foundation for the Gurted ecosystem.

**Specification:** [GURT Protocol Documentation](https://github.com/outpoot/gurted/blob/main/docs/docs/gurt-protocol.md)

## Features

- ✅ **`no_std` compatible** - Works in embedded and constrained environments
- ✅ **No allocations** - Zero heap allocations, stack-based only
- ✅ **No unsafe code** - 100% safe Rust
- ✅ **Complete protocol implementation** - All methods, status codes, and message formats
- ✅ **Well-documented** - Every component references the specification
- ✅ **Async I/O** - Uses `embedded-io-async` for transport abstraction

## Protocol Features

From the specification:

- **HTTP-like syntax** with familiar methods (GET, POST, PUT, DELETE, HEAD, OPTIONS, PATCH, HANDSHAKE)
- **Built-in required TLS 1.3 encryption** for all connections
- **Binary and text data support**
- **HTTP-compatible status codes**
- **Default port:** 4878
- **ALPN identifier:** `GURT/1.0`

## Usage

```rust
use portal_solutions_yo_gurt::{GurtClient, Method, StatusCode};

// Create a GURT client with your TLS transport
let mut client = GurtClient::new(tls_transport);

// Perform mandatory handshake
client.handshake("example.com", "yo-gurt/0.1").await?;

// Read handshake response
let mut response = client.response_reader();
let mut buf = [0u8; 512];
let (status, _) = response.read_status_line(&mut buf).await?;
assert_eq!(status, StatusCode::SwitchingProtocols);

// Skip headers
while response.read_header(&mut buf).await?.is_some() {}

// Make requests
client.request_no_body(Method::Get, "/api/data", "example.com", None).await?;

// Read response
let mut response = client.response_reader();
let (status, _) = response.read_status_line(&mut buf).await?;
```

## Protocol Requirements

Per the specification:

1. **Every GURT session must begin with a HANDSHAKE request**
2. **All connections must use TLS 1.3 encryption**
3. **Headers must be lowercase**
4. **Messages use CRLF (`\r\n`) line endings**

## Protocol Limits

The specification defines the following limits (available as constants):

- Maximum message size: 10 MB
- Default connection timeout: 10 seconds
- Default request timeout: 30 seconds
- Default handshake timeout: 5 seconds
- Maximum connection pool size: 10 connections
- Pool idle timeout: 300 seconds

## Implementation Notes

### Transport Abstraction

This implementation uses `embedded-io-async` traits for I/O operations, allowing it to work with any async transport layer. You're responsible for:

1. Establishing a TCP connection
2. Performing TLS 1.3 handshake with ALPN `GURT/1.0`
3. Providing the resulting transport to `GurtClient`

### Buffer Management

All operations use caller-provided buffers to avoid allocations. Ensure buffers are sized appropriately for your use case.

### Error Handling

Transport errors are propagated directly. Response parsing errors use the `ResponseError` enum which wraps transport errors and adds protocol-specific error cases.

## Specification Compliance

Every type, method, and constant in this crate includes documentation comments referencing the specific section of the GURT protocol specification it implements. This ensures full traceability and compliance with the spec.

## License

MPL-2.0 (see repository root for details)

## Contributions

This implementation is based solely on the public GURT protocol specification. The official implementation was not consulted to avoid license conflicts.
