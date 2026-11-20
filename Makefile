# Kybernate dashboard build targets. Tools are always used in their latest release.

IMAGE_REGISTRY ?= ghcr.io/kybernate
VERSION        ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT         ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
PLATFORMS      ?= linux/amd64,linux/arm64
HELM           ?= helm

LDFLAGS := -s -w -X github.com/kybernate/dashboard/internal/version.Version=$(VERSION) -X github.com/kybernate/dashboard/internal/version.Commit=$(COMMIT)

.PHONY: all
all: vet test build

.PHONY: fmt
fmt:
	go fmt ./...

.PHONY: vet
vet:
	go vet ./...

.PHONY: test
test:
	go test ./...

.PHONY: lint
lint:
	golangci-lint run

.PHONY: build
build: ## Build the dashboard into ./bin.
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/dashboard ./cmd/dashboard

.PHONY: run
run: build ## Run the dashboard against the cluster of the current kubeconfig.
	bin/dashboard --kubeconfig $${KUBECONFIG:-$$HOME/.kube/config} --listen 127.0.0.1:8080

.PHONY: image
image: ## Build the image for the local platform.
	docker build --build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) -t $(IMAGE_REGISTRY)/dashboard:$(VERSION) .

.PHONY: image-multiarch
image-multiarch: ## Build the image for all platforms.
	docker buildx build --platform $(PLATFORMS) --build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) -t $(IMAGE_REGISTRY)/dashboard:$(VERSION) .

.PHONY: helm-lint
helm-lint: ## Lint and render the Helm chart.
	$(HELM) lint charts/dashboard
	$(HELM) template dashboard charts/dashboard > /dev/null
	$(HELM) template dashboard charts/dashboard --set ingress.enabled=true --set ingress.host=gpu.example.com > /dev/null

.PHONY: clean
clean:
	rm -rf bin
