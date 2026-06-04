export function originFromRequest(request: Request): string {
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host");
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  if (host) {
    const scheme = proto ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
    return `${scheme}://${host}`;
  }
  return new URL(request.url).origin;
}
