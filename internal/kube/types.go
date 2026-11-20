package kube

// The dashboard reads GPUNode resources of the API group kybernate.io as
// unstructured objects and decodes only the fields it shows. It does not
// import the Go types of the kybernate module, so it keeps working with
// older and newer node agents: unknown fields are ignored, missing ones stay
// empty.

// GPUNode describes the GPUs of one Kubernetes node.
type GPUNode struct {
	Name   string        `json:"name"`
	Spec   GPUNodeSpec   `json:"spec"`
	Status GPUNodeStatus `json:"status"`
}

// GPUNodeSpec holds the reservations of a node.
type GPUNodeSpec struct {
	ReservedGPUs []string `json:"reservedGPUs,omitempty"`
}

// GPUNodeStatus is the inventory the node agent publishes.
type GPUNodeStatus struct {
	DriverVersion     string      `json:"driverVersion,omitempty"`
	CUDADriverVersion string      `json:"cudaDriverVersion,omitempty"`
	GPUCount          int32       `json:"gpuCount,omitempty"`
	ReservedCount     int32       `json:"reservedCount,omitempty"`
	PendingCount      int32       `json:"pendingCount,omitempty"`
	GPUs              []GPU       `json:"gpus,omitempty"`
	LastInventoryTime string      `json:"lastInventoryTime,omitempty"`
	Conditions        []Condition `json:"conditions,omitempty"`
}

// GPU is one GPU of a node.
type GPU struct {
	Index             int32          `json:"index"`
	UUID              string         `json:"uuid"`
	Name              string         `json:"name"`
	PCIBusID          string         `json:"pciBusID,omitempty"`
	PCIDeviceID       string         `json:"pciDeviceID,omitempty"`
	Architecture      string         `json:"architecture,omitempty"`
	ComputeCapability string         `json:"computeCapability,omitempty"`
	MemoryTotalBytes  int64          `json:"memoryTotalBytes,omitempty"`
	MemoryUsedBytes   int64          `json:"memoryUsedBytes,omitempty"`
	MIGEnabled        bool           `json:"migEnabled,omitempty"`
	Links             []GPULink      `json:"links,omitempty"`
	ProcessCount      int32          `json:"processCount,omitempty"`
	AllocatedTo       []PodReference `json:"allocatedTo,omitempty"`
	State             string         `json:"state,omitempty"`
}

// GPULink is the connection from one GPU to another GPU of the same node.
type GPULink struct {
	PeerUUID string `json:"peerUUID"`
	Type     string `json:"type"`
	NVLinks  int32  `json:"nvlinks,omitempty"`
	P2P      bool   `json:"p2p,omitempty"`
}

// PodReference names a container a GPU is allocated to.
type PodReference struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Container string `json:"container,omitempty"`
}

// Condition is a status condition of the node agent.
type Condition struct {
	Type               string `json:"type"`
	Status             string `json:"status"`
	Reason             string `json:"reason,omitempty"`
	Message            string `json:"message,omitempty"`
	LastTransitionTime string `json:"lastTransitionTime,omitempty"`
}

// User is the identity behind a token, as the API server sees it.
type User struct {
	Username string   `json:"username"`
	Groups   []string `json:"groups,omitempty"`
}

// Access tells what the user may do with GPUNode resources.
type Access struct {
	List    bool `json:"list"`
	Reserve bool `json:"reserve"`
}
