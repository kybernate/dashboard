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

All texts of the UI live in the dictionary `I18N` in `web/app.js`, one entry per language. Static texts in `index.html` carry `data-i18n` (text), `data-i18n-html` (markup) or `data-i18n-aria` (`aria-label`). Add every new text in English and German. Error messages from the API server stay in English.

The live updates come from `GET /api/gpunodes/events`, a stream of server-sent events. The server watches the `GPUNode`s and the `GPUWorkload`s with the user's token and sends both lists after every change, debounced by 250 ms. Workloads are suspended and resumed with `PUT /api/workloads/{namespace}/{name}/state`, which patches `spec.state`.

## Branches, pull requests and versions

As in `kybernate`: topic branches, pull requests with Conventional Commit titles, squash merges, and automatic releases. See [Releasing](releasing.md).
