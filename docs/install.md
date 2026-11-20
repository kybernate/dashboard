# Installing the dashboard

The dashboard is installed with its own Helm chart, published as an OCI artifact on GitHub Container Registry like the image. Both are public.

| Artifact | Location |
| --- | --- |
| Helm chart | `oci://ghcr.io/kybernate/charts/dashboard` |
| Image | `ghcr.io/kybernate/dashboard` |

## Requirements

- Kybernate is installed, see [Installing Kybernate](https://github.com/kybernate/kybernate/blob/main/docs/install/kybernate.md). The dashboard shows its `GPUNode` resources and uses its ClusterRoles `kybernate-viewer` and `kybernate-editor`.

## How it works

- **Sign-in with a bearer token:** Users sign in with a Kubernetes bearer token, as in the Kubernetes Dashboard. The dashboard forwards every request with this token to the API server, so Kubernetes RBAC decides what each user sees and changes.
- **No credentials of its own:** The dashboard has no permissions of its own. Its pod gets no ServiceAccount token, only the CA of the API server from the ConfigMap `kube-root-ca.crt`, which Kubernetes creates in every namespace.
- **Token storage:** The token is kept in an HttpOnly cookie with `SameSite=Strict`, so scripts in the page cannot read it. Requests that change something also need a header that other origins cannot send.
- **Session end:** The session ends when the browser is closed, when the user signs out or when the token expires.

| Role | Can |
| --- | --- |
| `kybernate-viewer`, or the built-in `view` | see the GPU inventory and the reservations |
| `kybernate-editor`, or the built-in `edit` | also reserve GPUs for Kybernate and release them |

## 1. Install

With the Helm CLI:

```bash
helm install dashboard oci://ghcr.io/kybernate/charts/dashboard \
  --namespace kybernate-system --set clusterName=<name>
```

With the Helm controller of K3s:

```bash
cat <<'EOF' | sudo k3s kubectl apply -f -
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: dashboard
  namespace: kube-system
spec:
  chart: oci://ghcr.io/kybernate/charts/dashboard
  targetNamespace: kybernate-system
  valuesContent: |-
    clusterName: <name>
EOF
```

## 2. Open the dashboard

Through a port forward:

```bash
kubectl -n kybernate-system port-forward service/dashboard 8080:80
```

Then open <http://localhost:8080>.

To reach it without a port forward, enable the Ingress. **Use TLS**, because the browser sends the user's token with every request:

```yaml
ingress:
  enabled: true
  className: traefik
  host: gpu.example.com
  tlsSecretName: gpu-example-com-tls
```

## 3. Get a token

A ServiceAccount that may reserve GPUs, with a token valid for 8 hours:

```bash
kubectl -n kybernate-system create serviceaccount gpu-admin
kubectl create clusterrolebinding gpu-admin \
  --clusterrole=kybernate-editor --serviceaccount=kybernate-system:gpu-admin
kubectl -n kybernate-system create token gpu-admin --duration=8h
```

For read-only access, bind `kybernate-viewer` instead. Any other token the API server accepts works as well, for example the token of a user from a static token file.

## Using the dashboard

| Area | Content |
| --- | --- |
| **Header** | GPUs and VRAM in the Kybernate pool, pending reservations, GPUs held by pods, number of GPU nodes |
| **Nodes** | Every GPU node with its GPUs, its interconnect and a bar per GPU: navy in the pool, orange pending, grey held by a pod. A red dot marks a node whose inventory failed or is older than 3 minutes. |
| **Topology and matrix** | How the GPUs are connected: NVLink, PCIe switch, CPU host bridge or across CPU sockets. The matrix follows `nvidia-smi topo -m`. |
| **GPU cards** | Model, VRAM, the pod holding the GPU, and the switch to reserve it. A GPU held by a pod can be reserved as well; it joins the pool once the pod has ended. |
| **Side panel** | Driver, CUDA version, age of the inventory and the pods holding GPUs of the node |

The dashboard refreshes every 5 seconds.

## Update

```bash
helm upgrade dashboard oci://ghcr.io/kybernate/charts/dashboard --namespace kybernate-system
```

With K3s, delete the installation job to pick up a new release: `kubectl -n kube-system delete job helm-install-dashboard`.

## Uninstall

```bash
helm uninstall dashboard --namespace kybernate-system
```

With K3s: `sudo k3s kubectl -n kube-system delete helmchart dashboard`. Reservations stay, they belong to the `GPUNode` resources.
