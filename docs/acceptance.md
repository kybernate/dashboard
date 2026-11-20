# Acceptance of phase 3: minimal dashboard

The tests run on any cluster with Kybernate installed, see [Kybernate acceptance](https://github.com/kybernate/kybernate/blob/main/docs/acceptance/README.md), and with the dashboard installed from its chart, as in [Installing the dashboard](install.md). They need a token for a ServiceAccount with the role `kybernate-editor` and one with `kybernate-viewer`. Run the browser tests in a current browser, on a desktop screen and at phone width.

| Test | Procedure | Expected |
| --- | --- | --- |
| Pod without credentials | `kubectl -n <namespace> get pod -l app.kubernetes.io/name=dashboard -o yaml` | no ServiceAccount token volume, only the CA from `kube-root-ca.crt` |
| Invalid token | sign in with a wrong token | rejected with a clear message, no cookie |
| Read-only user | sign in as `kybernate-viewer` | inventory visible, switches disabled; a reservation sent to the API directly is rejected with the message of the API server |
| Editor | sign in as `kybernate-editor` | GPUs can be reserved and released |
| Changes without the request header | `PUT` a reservation without `X-Kybernate-Request: 1` | 403 |
| Security headers | load the page | Content Security Policy without inline code, `X-Frame-Options: DENY`, no CSP violations in the browser console |
| Reserve a held GPU | start a pod requesting `nvidia.com/gpu`, reserve its GPU | the GPU shows *Pending* and joins the pool when the pod ends |
| Release a GPU | switch a reserved GPU off | the GPU shows *Free* |
| Live updates | change `spec.reservedGPUs` of a `GPUNode` with `kubectl` | the dashboard shows the change within a second, without reloading, and the header shows *Live* |
| Problems | serve a socket `nvidia-gpu-<id>.sock` in `/var/lib/kubelet/device-plugins` on a GPU node and restart its node agent | the header counts the node as needing attention, the node shows a hint how to fix it; both disappear when the socket is gone |
| Language | open the dashboard in a browser set to German, then press the language button | German UI, then English |
| Sign out | press *Sign out* | the cookie is deleted, the sign-in page shows |
| Phone width | open the dashboard at 390 pixels width | no horizontal scrolling, every control reachable |
