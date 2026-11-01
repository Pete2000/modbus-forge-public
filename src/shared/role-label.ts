// Keep legacy role identifiers for existing workspaces and trace consumers.
// Presentation names depend on the transport used by the actual request.
export function roleLabel(transport: "tcp" | "rtu", role: "master" | "slave"): string {
  if (transport === "tcp") return role === "master" ? "TCP 客户端" : "TCP 服务器";
  return role === "master" ? "RTU 主站" : "RTU 从站";
}
