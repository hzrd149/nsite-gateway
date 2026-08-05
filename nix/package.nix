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
    denoDepsHash = "sha256-UkN66tl8vUwhUW7/f48TKAYeH/85AznfL5Xfj2mrRMs=";

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
