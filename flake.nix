{
  description = "Pi coding agent dev environment with Node.js";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
        piCodingAgentVersion = "0.70.2";
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_24
            _1password-cli
            jq
          ];

          shellHook = ''
            unset http_proxy
            unset https_proxy
            unset no_proxy

            export NPM_CONFIG_PREFIX=~/.npm-global
            export PATH=~/.npm-global/bin:$PATH
            mkdir -p ~/.npm-global

            op account get --account my
            if [ $? -ne 0 ]; then
              eval $(op signin --account my)
            fi

            export AZURE_OPENAI_API_KEY=$(op item get "Azure OpenAI API Key" --vault Private --fields label=key --format json | jq -r '.value')
            export AZURE_OPENAI_BASE_URL="$(op item get "Azure OpenAI API Key" --vault Private --fields label=url --format json | jq -r '.value')/openai/v1"

            if ! npm list -g @mariozechner/pi-coding-agent@${piCodingAgentVersion} > /dev/null 2>&1; then
              npm install -g @mariozechner/pi-coding-agent@${piCodingAgentVersion}
            fi

            exec pi
          '';
        };

        formatter = pkgs.alejandra;
      }
    );
}
