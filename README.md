# Kybernate Dashboard

[kybernate.io](https://kybernate.io) · [Apache 2.0](LICENSE) · by [CloudCourse GmbH](https://cloudcourse.de)

A web dashboard for [Kybernate](https://github.com/kybernate/kybernate): the GPUs of every node with their memory, their interconnect and the pods holding them, and the reservations of the Kybernate GPU pool.

- **Inventory:** every GPU node with model, VRAM, driver and an NVLink/PCIe topology view and matrix
- **Allocations:** which pod holds which GPU
- **Reservations:** reserve GPUs for Kybernate or return them to regular pods. A GPU held by a pod can be reserved as well and joins the pool once the pod has ended.
- **Live and clear:** every change in the cluster shows within a second. Nodes that need attention, for example because another device plugin still runs there, are marked with a hint how to fix it.
- **Your identity:** sign in with a Kubernetes bearer token. Kubernetes RBAC decides what you can see and change. The dashboard has no credentials of its own.
- **English and German**, following the language of the browser.

## Documentation

- [Website: kybernate.io](https://kybernate.io), with an interactive demo of this dashboard
- [Installing the dashboard](docs/install.md)
- [Development](docs/development.md)
- [Releasing](docs/releasing.md)
- [Acceptance of phase 3](docs/acceptance.md)

## Status

Phase 3 of the [Kybernate roadmap](https://github.com/kybernate/kybernate/blob/main/ROADMAP.md): inventory and reservation. Model instances, their temperature and actions on them follow with the later phases.

## Authors

<a href="https://cloudcourse.de">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/cloudcourse-logo-dark.svg">
    <img src="docs/assets/cloudcourse-logo.svg" alt="CloudCourse GmbH" height="64">
  </picture>
</a>

The Kybernate Dashboard is developed by **Andre Lohmann** ([lohmann.andre@gmail.com](mailto:lohmann.andre@gmail.com)) and **[CloudCourse GmbH](https://cloudcourse.de)**.

## License

Open source under the [Apache License 2.0](LICENSE).
Copyright 2026 Andre Lohmann and CloudCourse GmbH, see [NOTICE](NOTICE).
