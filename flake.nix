{
  description = "nsite gateway - serve Nostr websites over HTTP";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    deno2nix.url = "github:hzrd149/deno2nix";
    deno2nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      deno2nix,
    }:
    let
      systems = [
        "x86_64-linux"
      ];

      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f system (
            import nixpkgs {
              inherit system;
              overlays = [ deno2nix.overlays.default ];
            }
          )
        );

      # Exactly what `deno run main.ts` needs, listed explicitly so unrelated
      # files — planning notes, test fixtures, .env files, `nix build` result
      # symlinks — can never change the derivation or leak into the store.
      src = nixpkgs.lib.fileset.toSource {
        root = ./.;
        fileset = nixpkgs.lib.fileset.unions [
          ./main.ts
          ./deno.json
          ./deno.lock
          ./src
          # Read at startup via import.meta.url (src/helpers/inline-css.ts).
          ./public
        ];
      };
    in
    {
      nixosModules = {
        nsite-gateway = import ./nix/module.nix self;
        default = self.nixosModules.nsite-gateway;
      };

      packages = forAllSystems (
        system: pkgs:
        (import ./nix/package.nix {
          inherit pkgs src;
          version = (builtins.fromJSON (builtins.readFile ./deno.json)).version;
        })
        // {
          # `nix run .#vm` — a disposable demonstration VM.
          vm =
            (nixpkgs.lib.nixosSystem {
              modules = [
                { nixpkgs.hostPlatform = system; }
                "${nixpkgs}/nixos/modules/virtualisation/qemu-vm.nix"
                self.nixosModules.default
                ./nix/example-vm.nix
              ];
            }).config.system.build.vm;
        }
      );

      apps = forAllSystems (
        system: _pkgs: {
          default = {
            type = "app";
            program = "${self.packages.${system}.default}/bin/nsite-gateway";
            meta.description = "Run the nsite gateway";
          };
        }
      );

      devShells = forAllSystems (
        _system: pkgs: {
          default = pkgs.mkShell {
            packages = [ pkgs.deno ];

            shellHook = ''
              echo "nsite gateway dev shell"
              echo "  deno task dev"
              echo "  nix build .#nsite-gateway"
            '';
          };
        }
      );

      checks = forAllSystems (
        system: _pkgs: {
          package = self.packages.${system}.default;
        }
      );
    };
}
