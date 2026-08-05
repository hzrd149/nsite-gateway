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

      sourceExclusions = [
        ".git"
        ".planning"
        ".claude"
        "data"
        "flake.nix"
        "flake.lock"
        "nix"
        "node_modules"
        "vendor"
      ];

      src = nixpkgs.lib.cleanSourceWith {
        src = ./.;
        filter = path: _type: !(nixpkgs.lib.elem (baseNameOf path) sourceExclusions);
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
