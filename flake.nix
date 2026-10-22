{
  description = "Nsite gateway unit tests";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      test = pkgs.writeShellApplication {
        name = "nsite-gateway-test";
        runtimeInputs = [ pkgs.deno ];
        text = ''
          export DENO_NO_UPDATE_CHECK=1
          export DENO_NO_PROMPT=1
          export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
          exec deno task test --frozen
        '';
      };
    in {
      apps.${system}.test = {
        type = "app";
        program = "${test}/bin/nsite-gateway-test";
      };
    };
}
