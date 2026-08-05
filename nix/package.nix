{
  pkgs,
  src,
  version,
  systems,
}:
let
  inherit (pkgs) lib stdenvNoCC;

  denoDeps = stdenvNoCC.mkDerivation {
    pname = "nsite-gateway-deno-deps";
    inherit version src;

    nativeBuildInputs = [ pkgs.deno ];

    buildPhase = ''
      runHook preBuild

      export DENO_DIR="/build/deno-dir"
      deno install --frozen --lock=deno.lock --vendor --node-modules-dir=auto --entrypoint main.ts

      mkdir -p "$out"
      cp -R vendor node_modules "$out/"

      runHook postBuild
    '';

    dontInstall = true;
    outputHashMode = "recursive";
    outputHash = "sha256-7u8E6xLaGwVK5zt/7D5khPRV7/TvkOQBS6XPfKK8KbQ=";
  };

  nsite-gateway = stdenvNoCC.mkDerivation {
    pname = "nsite-gateway";
    inherit version src;

    nativeBuildInputs = [ pkgs.makeWrapper ];

    installPhase = ''
      runHook preInstall

      mkdir -p "$out/share/nsite-gateway" "$out/bin"
      cp -R main.ts deno.json deno.lock public src "$out/share/nsite-gateway/"
      cp -R ${denoDeps}/vendor ${denoDeps}/node_modules "$out/share/nsite-gateway/"

      makeWrapper ${lib.getExe pkgs.deno} "$out/bin/nsite-gateway" \
        --chdir "$out/share/nsite-gateway" \
        --add-flags "run" \
        --add-flags "--cached-only" \
        --add-flags "--unstable-kv" \
        --add-flags "--allow-env" \
        --add-flags "--allow-net" \
        --add-flags "--allow-read" \
        --add-flags "--allow-write" \
        --add-flags "--config=$out/share/nsite-gateway/deno.json" \
        --add-flags "--frozen" \
        --add-flags "--lock=$out/share/nsite-gateway/deno.lock" \
        --add-flags "$out/share/nsite-gateway/main.ts"

      runHook postInstall
    '';

    meta = {
      description = "Deno gateway for serving Nostr websites over HTTP";
      homepage = "https://github.com/hzrd149/nsite-gateway";
      license = lib.licenses.mit;
      mainProgram = "nsite-gateway";
      platforms = systems;
    };
  };
in
{
  default = nsite-gateway;
  inherit nsite-gateway denoDeps;
}
