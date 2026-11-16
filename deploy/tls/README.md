# Your own TLS certificate (production profile)

Put `tls.crt` (the full chain) and `tls.key` here and set `GANTRY_TLS="/certs/tls.crt /certs/tls.key"`, or set `GANTRY_TLS_DIR` to another directory. The files are mounted read-only into the ingress; nothing in this directory except this README is committed. With `GANTRY_TLS` set to an email address, Caddy gets a certificate from Let's Encrypt instead and this directory stays empty.
