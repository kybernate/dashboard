# Acceptance of phase 3: minimal dashboard

Tested on the GPU test cluster of Kybernate (three nodes with 2× RTX 3060 each, see [Kybernate acceptance](https://github.com/kybernate/kybernate/blob/main/docs/acceptance/README.md)), with the dashboard installed from its chart in the namespace `kybernate-system`, through a port forward. The browser tests ran headless with Playwright in Chromium, at 1440×900 and 390×844 pixels.

## Results

| Test | Expected | 2026-11-20 |
| --- | --- | --- |
| Pod without credentials | The pod has no ServiceAccount token, only the CA of `kube-root-ca.crt` | passed |
| Sign-in with an invalid token | rejected with a clear message, no cookie | passed |
| Sign-in as `kybernate-viewer` | inventory visible, switches disabled; a reservation through the API is rejected with the message of the API server | passed |
| Sign-in as `kybernate-editor` | inventory visible, GPUs can be reserved and released | passed |
| Change requests without the header `X-Kybernate-Request` | 403 | passed |
| Security headers | Content Security Policy without inline code, `X-Frame-Options: DENY` | passed, no CSP violations in the browser |
| Reserve a GPU held by a pod | the GPU shows *Pending* and joins the pool when the pod ends | passed |
| Release a GPU | the GPU shows *Free* | passed |
| Live updates | a reservation changed with `kubectl` shows without reloading | passed, within 1 s |
| Problems | with a socket of the NVIDIA device plugin on a node, the header shows *1 node needs attention* and the node a hint how to fix it; both disappear when the socket is gone | passed |
| Language | a German browser gets the German UI; the button switches to English | passed |
| Sign out | the cookie is deleted | passed |
| Phone width | no horizontal scrolling, all controls reachable | passed |

The live updates and the problem display need Kybernate with the conditions `DevicePluginReady` and `CDIReady`, from the release after `v0.2.0`. With `v0.2.0`, the dashboard shows failed and outdated inventories only.
