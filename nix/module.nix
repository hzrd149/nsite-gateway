self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.nsite-gateway;
in
{
  options.services.nsite-gateway = {
    enable = lib.mkEnableOption "nsite gateway";

    package = lib.mkPackageOption self.packages.${pkgs.stdenv.hostPlatform.system} "nsite-gateway" { };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to open the configured nsite gateway TCP port in the firewall.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/nsite-gateway.env";
      description = "Environment file containing additional configuration or secrets.";
    };

    settings = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        PUBLIC_DOMAIN = "nsite.example.com";
        NOSTR_RELAYS = "wss://relay.example.com";
      };
      description = ''
        Environment variables passed to the gateway. Secret values should be
        supplied through environmentFile because these values enter the
        world-readable Nix store.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    services.nsite-gateway.settings = {
      NSITE_HOST = lib.mkDefault "0.0.0.0";
      NSITE_PORT = lib.mkDefault "3000";
      CACHE_PATH = lib.mkDefault "/var/lib/nsite-gateway/cache.kv";
    };

    networking.firewall.allowedTCPPorts = lib.optional cfg.openFirewall (lib.toInt cfg.settings.NSITE_PORT);

    systemd.services.nsite-gateway = {
      description = "nsite gateway";
      documentation = [ "https://github.com/hzrd149/nsite-gateway" ];
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

      environment = cfg.settings // {
        DENO_DIR = "/var/cache/nsite-gateway/deno";
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
        RestartSec = 5;

        DynamicUser = true;
        StateDirectory = "nsite-gateway";
        CacheDirectory = "nsite-gateway";
        UMask = "0077";

        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectSystem = "strict";
        RestrictSUIDSGID = true;
      }
      // lib.optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = cfg.environmentFile;
      };
    };
  };
}
