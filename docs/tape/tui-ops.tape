# Gravação da TUI: operar uma config que já existe — rodar, instalar em
# background e ler log.
#
# Rodar com:  bun run rec:tui        (ou: vhs docs/tape/tui-ops.tape)
# Requisitos: vhs + ttyd + ffmpeg no PATH, `pulsar` instalado (bun run get:cli)
#             e os containers de teste no ar (bun run test:up).

Output docs/media/tui-ops.gif

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
Set Theme { "background": "#12101a", "foreground": "#e6e1ef", "cursor": "#b44dff", "black": "#1c1826", "red": "#ff6b6b", "green": "#5ee6a8", "yellow": "#ffcf6b", "blue": "#7aa2f7", "magenta": "#b44dff", "cyan": "#7ee0e0", "white": "#e6e1ef", "brightBlack": "#6b6280", "brightRed": "#ff8a8a", "brightGreen": "#8ff0c4", "brightYellow": "#ffe0a0", "brightBlue": "#a3bdff", "brightMagenta": "#e0b3ff", "brightCyan": "#a8f0f0", "brightWhite": "#ffffff" }

Hide
Type "cd docs/demo && clear"
Enter
Sleep 1s
Show

Type "pulsar"
Sleep 400ms
Enter
Sleep 3s

# --- rodar a config selecionada (r age sobre a linha destacada) ---
Type "r"
Sleep 2s
Enter
Sleep 8s

# parar: SIGTERM, o pulsar grava o resume token antes de sair
Type "s"
Sleep 4s
Escape
Sleep 1500ms

# --- background: o plano aparece antes de qualquer efeito ---
Type "b"
Sleep 4s
Tab
Sleep 1500ms
Down
Sleep 1500ms
Up
Sleep 1s
Escape
Sleep 1500ms

# --- logs: histórico gravado, com busca ---
Type "l"
Sleep 3s
Tab
Sleep 1s
Down
Sleep 2s
Tab
Sleep 1s
Type "/"
Sleep 400ms
Type "SYNC"
Sleep 2500ms
Escape
Sleep 2s
Escape
Sleep 2s

Ctrl+C
Sleep 400ms
