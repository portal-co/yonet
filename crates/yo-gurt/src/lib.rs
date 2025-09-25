#![no_std]
pub struct GurtClient<T> {
    pub transport: T,
}
impl<T: embedded_io_async::Read + embedded_io_async::Write> GurtClient<T> {
    pub async fn no_body<'a>(
        &'a mut self,
        name: &str,
        path: &str,
        host: &str,
        ua: Option<&str>,
    ) -> Result<GurtBody<'a, T>, T::Error> {
        let ua = ua.unwrap_or_else(|| "yo-gurt/0.1");
        self.transport.write_all(name.as_bytes()).await?;
        self.transport.write_all(b" ").await?;
        self.transport.write_all(path.as_bytes()).await?;
        self.transport.write_all(b" GURT/1.0.0\r\nhost:").await?;
        self.transport.write_all(host.as_bytes()).await?;
        self.transport.write_all(b"\r\nuser-agent:").await?;
        self.transport.write_all(ua.as_bytes()).await?;
        self.transport.write_all(b"\r\n\r\n").await?;
    }
}
