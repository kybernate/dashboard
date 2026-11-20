// Command dashboard serves the Kybernate dashboard.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/kybernate/dashboard/internal/kube"
	"github.com/kybernate/dashboard/internal/server"
	"github.com/kybernate/dashboard/internal/version"
	"github.com/kybernate/dashboard/web"
)

// defaultCAFile is where the Helm chart mounts the CA of the API server from
// the ConfigMap kube-root-ca.crt. The pod gets no ServiceAccount token.
const defaultCAFile = "/var/run/kybernate/ca.crt"

type options struct {
	listen      string
	apiServer   string
	caFile      string
	kubeconfig  string
	clusterName string
}

func main() {
	var o options
	flag.StringVar(&o.listen, "listen", ":8080", "address to serve the dashboard on")
	flag.StringVar(&o.apiServer, "api-server", "", "URL of the Kubernetes API server; defaults to the in-cluster address")
	flag.StringVar(&o.caFile, "api-ca-file", defaultCAFile, "CA bundle to verify the API server with")
	flag.StringVar(&o.kubeconfig, "kubeconfig", "", "take the API server address and CA from this kubeconfig instead, for development; its credentials are not used")
	flag.StringVar(&o.clusterName, "cluster-name", "", "name of the cluster shown in the dashboard")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version.String())
		return
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log, o); err != nil {
		log.Error("dashboard stopped", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger, o options) error {
	cfg, err := apiConfig(o)
	if err != nil {
		return err
	}
	s := &server.Server{
		Cluster:     kube.New(cfg, "kybernate-dashboard/"+version.Version),
		ClusterName: o.clusterName,
		Static:      web.FS,
		Version:     version.Version,
		Log:         log,
	}
	srv := &http.Server{Addr: o.listen, Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	errs := make(chan error, 1)
	go func() { errs <- srv.ListenAndServe() }()
	log.Info("dashboard started", "version", version.Version, "commit", version.Commit, "listen", o.listen, "apiServer", cfg.Host)

	select {
	case <-ctx.Done():
	case err := <-errs:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	log.Info("dashboard stopping")
	return srv.Shutdown(shutdown)
}

// apiConfig returns the address and CA of the API server. Credentials are
// never taken from it; every request carries the user's token.
func apiConfig(o options) (*rest.Config, error) {
	if o.kubeconfig != "" {
		cfg, err := clientcmd.BuildConfigFromFlags(o.apiServer, o.kubeconfig)
		if err != nil {
			return nil, fmt.Errorf("loading %s: %w", o.kubeconfig, err)
		}
		return cfg, nil
	}
	host := o.apiServer
	if host == "" {
		h, p := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
		if h == "" || p == "" {
			return nil, errors.New("not running in a cluster: set --api-server or --kubeconfig")
		}
		host = "https://" + net.JoinHostPort(h, p)
	}
	return &rest.Config{Host: host, TLSClientConfig: rest.TLSClientConfig{CAFile: o.caFile}}, nil
}
