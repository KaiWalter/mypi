{
  description = "Pi coding agent dev environment with Node.js";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
        piCodingAgentVersion = "0.70.2";
        # Use the vendored local pi-telegram extension so our modifications are picked up.
        extTelegram = "./vendor/pi-telegram";
        extSkillShell = "npm:pi-skills-sh";
        extComputerUse = "git:github.com/injaneity/pi-computer-use";
        commonBuildInputs = with pkgs; [
          nodejs_24
          _1password-cli
          jq
        ];
        commonShellHook = ''
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
        '';
        notesSystemPrompt = ''
          You are Q&A assistant working exclusively on Obsidian Vault '~/OneDrive - Carl Zeiss AG/Notes' using skill 'obsidian-vault-qa'.
          In this vault, the Contacts/ sub-folder contains all persons I am in contact with, maintained as dossier-style notes.
          When identifying, listing, or answering questions about people, prefer Contacts/ over other folders whenever possible.
        '';
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = commonBuildInputs;
          shellHook =
            commonShellHook
            + ''

              exec pi -e ${extTelegram} -e ${extSkillShell} "/telegram-connect"

            '';
        };

        devShells.notes = pkgs.mkShell {
          buildInputs = commonBuildInputs;
          shellHook =
            commonShellHook
            + ''

              exec pi -e ${extTelegram} --system-prompt ${builtins.toJSON notesSystemPrompt} "/telegram-connect"

            '';
        };

        devShells.computer-use = pkgs.mkShell {
          buildInputs = commonBuildInputs;
          shellHook =
            commonShellHook
            + ''

              exec pi -e ${extTelegram} -e ${extSkillShell} -e ${extComputerUse} "/telegram-connect"

            '';
        };

        devShells.shell = pkgs.mkShell {
          buildInputs = commonBuildInputs;
          shellHook = commonShellHook;
        };

        devShells.mini = pkgs.mkShell {
          buildInputs = commonBuildInputs;
          shellHook =
            commonShellHook
            + ''

              exec pi
            '';
        };

        formatter = pkgs.alejandra;
      }
    );
}
