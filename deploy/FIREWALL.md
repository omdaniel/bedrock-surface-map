# Private Ingest Boundary

The reference deployment requires Docker's **iptables firewall backend**, with
`DOCKER-USER` traversed before Docker's accept rules. The `iptables-nft` command
frontend is compatible; Docker's separate native nftables backend is not this
recipe. Do not change the host backend to make a test pass. A missing or bypassed
chain blocks acceptance until the administrator supplies an equivalent reviewed
policy and verifies it from outside the map host.

`deploy init` writes a private `firewall-review.sh` using the configured ingest
address, enabled ports and BDS source IPv4. It never runs it. Review that file and
the host's existing rules before starting the deployment. The script inserts only
project-commented DROP rules for incoming connections to those original published
destinations from other sources; it neither flushes chains nor changes defaults.
`--ctdir ORIGINAL` excludes return traffic. Matching original destination tuples
is necessary because Docker translates published ports before `DOCKER-USER`.
[Docker's iptables guidance](https://docs.docker.com/engine/network/firewall-iptables/)

```sh
sudo iptables -S DOCKER-USER
sudo sh ./map-deploy/firewall-review.sh apply
sudo sh ./map-deploy/firewall-review.sh check
```

These commands require explicit administrator approval. `check` verifies rule
presence, not packet-path isolation. The existing policy must still allow the
declared BDS source; this recipe does not override unrelated deny rules. Do not
forward ingest ports on the router. HTTP credentials are confidential only to
the extent that the selected LAN/VPN is trusted.

## Verify Both Sides

- From the declared BDS source, contact each enabled ingest endpoint without a
  token. An HTTP authentication refusal proves network reachability without
  disclosing a secret. Verify successful publication separately with the pack.
- From a different LAN/VPN device, the same TCP connection must fail. A `401`
  response here means network isolation failed even though token checks work.
- From outside the trusted network, ingest must be unreachable. Public TCP80/443
  belong to the gateway, not the collectors. Collector reads, Caddy admin and
  health details must not have published host ports.
- Repeat after Docker/host restart. Arrange rule persistence through the host's
  existing firewall manager, after Docker creates its chains. Do not assume these
  runtime rules survive reboot or that UFW alone filters Docker-published ports.

Select the source address observed at the map host, accounting for any deliberate
VPN/NAT path. A BDS container on the same host may arrive from its bridge address,
not the host's LAN address. Do not broaden to an entire subnet to mask a mismatch.
Host-originated traffic and direct same-bridge container traffic do not necessarily
traverse these forwarded published-port rules; local administrators remain trusted
and ingest authentication remains required. The gateway has no ingest credential.

Stop the deployment before removing its restrictions:

```sh
docker compose --project-directory ./map-deploy -f ./map-deploy/compose.yaml stop
sudo sh ./map-deploy/firewall-review.sh remove
```

Removal deletes only the exact generated rules. It is not a general firewall
rollback. Live remote-vantage validation is a deployment acceptance requirement,
not something a localhost health check can certify.

The generated-runtime CI gate tests this recipe on disposable Docker hosts using
separately routed allowed and denied client network namespaces, not Docker bridge
hairpins. Operation-owned links use a private subnet with no existing route
overlap and are removed during cleanup. The test establishes both routes
before filtering, verifies return traffic and actual drop counters, and checks
repeated apply/remove operations. These synthetic vantages do not replace the
installation's LAN/VPN and public-network checks.
