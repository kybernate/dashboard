# Development

## Layout

| Path | Content |
| --- | --- |
| `cmd/dashboard` | The server binary |
| `internal/kube` | Calls to the Kubernetes API with the user's token. `GPUNode` is read as an unstructured object, so the dashboard does not depend on the Go module of `kybernate`. |
| `internal/server` | HTTP handlers: sign-in, session, GPU nodes, reservations, security headers |
| `web` | The UI: `index.html`, `app.js`, `style.css`, embedded into the binary. Plain JavaScript without a build step. |
| `charts/dashboard` | Helm chart |

## Running locally

The dashboard can run on a workstation against any cluster. With `--kubeconfig` it takes only the address and the CA of the API server from the kubeconfig, never its credentials:

```bash
make run
```

Then open <http://localhost:8080> and sign in with a token, for example from `kubectl create token`.

## Checks

```bash
make vet test lint helm-lint
```

The Content Security Policy allows only scripts and styles from the dashboard itself, without inline code. Set dynamic styles through the DOM (`element.style`), not through `style` attributes in HTML strings.

## Branches, pull requests and versions

As in `kybernate`: topic branches, pull requests with Conventional Commit titles, squash merges, and automatic releases. See [Releasing](releasing.md).
