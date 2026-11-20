# syntax=docker/dockerfile:1

# The binary is static and the build cross-compiles, so it runs on the
# build platform for every target platform.
FROM --platform=$BUILDPLATFORM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETOS TARGETARCH
ARG VERSION=dev
ARG COMMIT=unknown
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath \
      -ldflags "-s -w -X github.com/kybernate/dashboard/internal/version.Version=${VERSION} -X github.com/kybernate/dashboard/internal/version.Commit=${COMMIT}" \
      -o /out/dashboard ./cmd/dashboard

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /out/dashboard /usr/local/bin/dashboard
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/dashboard"]
