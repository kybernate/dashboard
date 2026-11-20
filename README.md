# Kybernate Dashboard

A web dashboard for [Kybernate](https://github.com/kybernate/kybernate): the GPUs of every node with their memory, their interconnect and the pods holding them, and the reservations of the Kybernate GPU pool.

- **Inventory:** every GPU node with model, VRAM, driver and an NVLink/PCIe topology view and matrix
- **Allocations:** which pod holds which GPU
- **Reservations:** reserve GPUs for Kybernate or return them to regular pods. A GPU held by a pod can be reserved as well and joins the pool once the pod has ended.
- **Live and clear:** every change in the cluster shows within a second. Nodes that need attention, for example because another device plugin still runs there, are marked with a hint how to fix it.
- **Your identity:** sign in with a Kubernetes bearer token. Kubernetes RBAC decides what you can see and change. The dashboard has no credentials of its own.
- **English and German**, following the language of the browser.

## Documentation

- [Installing the dashboard](docs/install.md)
- [Development](docs/development.md)
- [Releasing](docs/releasing.md)
- [Acceptance of phase 3](docs/acceptance.md)

## Status

Phase 3 of the [Kybernate roadmap](https://github.com/kybernate/kybernate/blob/main/ROADMAP.md): inventory and reservation. Model instances, their temperature and actions on them follow with the later phases.
