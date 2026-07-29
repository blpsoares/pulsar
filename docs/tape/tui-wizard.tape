# Gravação da TUI: criar uma config do zero.
#
# Rodar com:  bun run rec:tui        (ou: vhs docs/tape/tui-wizard.tape)
# Requisitos: vhs + ttyd + ffmpeg no PATH, `pulsar` instalado (bun run get:cli)
#             e os containers de teste no ar (bun run test:up).
#
# A gravação usa o Mongo de teste do próprio repositório — as URIs que aparecem
# na tela são localhost, então não há credencial nenhuma no GIF.

Output docs/media/tui-wizard.gif

Require pulsar

Set Shell bash
Set FontSize 13
Set Width 1180
Set Height 720
Set Padding 14
Set Framerate 20
Set TypingSpeed 45ms
Set WindowBar Colorful
Set BorderRadius 8
# Fundo escuro levemente arroxeado, para o roxo da marca (#9b00ff) não brigar
# com o fundo nem estourar de contraste.
Set Theme { "background": "#12101a", "foreground": "#e6e1ef", "cursor": "#b44dff", "black": "#1c1826", "red": "#ff6b6b", "green": "#5ee6a8", "yellow": "#ffcf6b", "blue": "#7aa2f7", "magenta": "#b44dff", "cyan": "#7ee0e0", "white": "#e6e1ef", "brightBlack": "#6b6280", "brightRed": "#ff8a8a", "brightGreen": "#8ff0c4", "brightYellow": "#ffe0a0", "brightBlue": "#a3bdff", "brightMagenta": "#e0b3ff", "brightCyan": "#a8f0f0", "brightWhite": "#ffffff" }

Hide
Type "cd docs/demo && clear"
Enter
Sleep 1s
Show

Type "pulsar"
Sleep 500ms
Enter
Sleep 3s

# --- tela inicial: navegar pelas configs existentes ---
Down
Sleep 1500ms
Up
Sleep 1s

# --- criar uma config nova ---
Tab
Sleep 800ms
Enter
Sleep 1500ms

# modo: sync
Enter
Sleep 1500ms

# origem
Type "mongodb://127.0.0.1:27020/?replicaSet=rs0&directConnection=true"
Sleep 500ms
Enter
Sleep 3s
Enter
Sleep 2s

# destino
Type "mongodb://127.0.0.1:27021"
Sleep 400ms
Enter
Sleep 2500ms
Type "replica"
Sleep 400ms
Enter
Sleep 2500ms

# --- collections: ligar as estimativas ---
Type "e"
Sleep 1s
Space
Sleep 2500ms
Escape
Sleep 1s

# busca incremental
Type "/"
Sleep 400ms
Type "pag"
Sleep 1800ms
Escape
Sleep 600ms
Space
Sleep 800ms

# limpa a busca e marca um punhado
Type "/"
Sleep 300ms
Backspace
Backspace
Backspace
Sleep 800ms
Escape
Sleep 500ms
Down
Space
Sleep 400ms
Down
Space
Sleep 400ms
Down
Down
Space
Sleep 1500ms

# contagem exata da collection sob o cursor
Type "c"
Sleep 2s

Enter
Sleep 1500ms

# --- avançado: copiar índices ---
Space
Sleep 1200ms
Down
Sleep 600ms
Space
Sleep 1500ms
Enter
Sleep 2s

# --- revisar e salvar ---
Sleep 3s
Enter
Sleep 2s

# de volta ao início: a config nova aparece na lista
Down
Sleep 3s

Ctrl+C
Sleep 400ms

# A gravação não pode deixar lixo versionado: o yml criado durante a demo sai.
Hide
Type "rm -f replica-sync.yml"
Enter
Sleep 500ms
Show
