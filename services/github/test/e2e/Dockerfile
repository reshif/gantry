# TEST/SANDBOX ONLY. Adds git to a gantry-github image that was built with INSTALL_GIT=false, for hosts whose Alpine mirror is
# unreachable (apk add git fails). The binaries come from alpine/git, which is the same Alpine release (musl), so they run as-is.
#   docker build --build-arg INSTALL_GIT=false -f services/github/Dockerfile -t gantry-github-nogit:dev .
#   docker build -f services/github/test/e2e/Dockerfile -t gantry-github:dev services/github/test/e2e
# Test-only helper image: it must track the Alpine release the runtime image uses, so it is not pinned (hadolint DL3007 accepted here only).
# hadolint ignore=DL3007
FROM alpine/git:latest AS git
FROM gantry-github-nogit:dev
USER root
COPY --from=git /usr/bin/git /usr/bin/git
COPY --from=git /usr/libexec/git-core /usr/libexec/git-core
COPY --from=git /usr/share/git-core /usr/share/git-core
COPY --from=git /etc/gitconfig /etc/gitconfig
COPY --from=git /usr/lib/libbrotlicommon.so.1 /usr/lib/libbrotlidec.so.1 /usr/lib/libcares.so.2 /usr/lib/libcurl.so.4 /usr/lib/libidn2.so.0 /usr/lib/libnghttp2.so.14 /usr/lib/libpcre2-8.so.0 /usr/lib/libpsl.so.5 /usr/lib/libunistring.so.5 /usr/lib/libzstd.so.1 /usr/lib/
USER 10001:10001
