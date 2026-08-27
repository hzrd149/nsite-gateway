{
  pkgs,
  src,
  version,
}:
let
  inherit (pkgs) lib;

  nsite-gateway = pkgs.buildDenoApplication {
    pname = "nsite-gateway";
    inherit version src;

    entrypoint = "main.ts";
    denoDepsHash = "sha256-0nFZ2ZmvQ+bPmZKU51MKWZ8t8tVaP6kKTeghwIwSj0Y=";

    runFlags = [
      "--unstable-kv"
      "--allow-env"
      "--allow-net"
      "--allow-read"
      "--allow-write"
    ];

    meta = {
      description = "Deno gateway for serving Nostr websites over HTTP";
      homepage = "https://github.com/hzrd149/nsite-gateway";
      license = lib.licenses.mit;
    };
  };
in
{
  default = nsite-gateway;
  inherit nsite-gateway;
  denoDeps = nsite-gateway.denoDeps;
}
