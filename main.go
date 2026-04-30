package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	wailslogger "github.com/wailsapp/wails/v2/pkg/logger"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var appIcon []byte

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:             "Accidia",
		Width:             1280,
		Height:            820,
		MinWidth:          900,
		MinHeight:         600,
		DisableResize:     false,
		Fullscreen:        false,
		Frameless:         true,
		StartHidden:       false,
		HideWindowOnClose: false,
		// Make the underlying window background fully transparent so platform
		// vibrancy / mica / GTK alpha can show through. The visible UI is
		// painted by React with its own gradient + backdrop-filter blur.
		BackgroundColour: &options.RGBA{R: 0, G: 0, B: 0, A: 0},
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: app.Media(),
		},
		Menu:             nil,
		Logger:           nil,
		LogLevel:         wailslogger.INFO,
		OnStartup:        app.startup,
		OnDomReady:       app.domReady,
		OnBeforeClose:    app.beforeClose,
		OnShutdown:       app.shutdown,
		WindowStartState: options.Normal,
		Bind: []interface{}{
			app,
		},
		// ---------------------------------------------------------------
		// Windows (Win10/11)
		// Mica + acrylic provide the soft blurred backdrop on Win11.
		// ---------------------------------------------------------------
		Windows: &windows.Options{
			WebviewIsTransparent:              true,
			WindowIsTranslucent:               true,
			BackdropType:                      windows.Mica,
			DisableFramelessWindowDecorations: false,
			Theme:                             windows.Dark,
			CustomTheme: &windows.ThemeSettings{
				DarkModeTitleBar:   windows.RGB(8, 12, 24),
				DarkModeTitleText:  windows.RGB(245, 245, 250),
				DarkModeBorder:     windows.RGB(20, 25, 40),
				LightModeTitleBar:  windows.RGB(8, 12, 24),
				LightModeTitleText: windows.RGB(245, 245, 250),
				LightModeBorder:    windows.RGB(20, 25, 40),
			},
		},
		// ---------------------------------------------------------------
		// macOS — translucent with system vibrancy.
		// ---------------------------------------------------------------
		Mac: &mac.Options{
			TitleBar: &mac.TitleBar{
				TitlebarAppearsTransparent: true,
				HideTitle:                  true,
				HideTitleBar:               false,
				FullSizeContent:            true,
				UseToolbar:                 false,
				HideToolbarSeparator:       true,
			},
			Appearance:           mac.NSAppearanceNameDarkAqua,
			WebviewIsTransparent: true,
			WindowIsTranslucent:  true,
			About: &mac.AboutInfo{
				Title: "Accidia",
				Message: "Accidia " + Version + "\n" +
					"A native music player with the Infinite Jukebox loop engine.\n\n" +
					"By Carlo Esposito for Eyed®.\n" +
					"Infinite Jukebox concept by Paul Lamere (The Echo Nest, 2012).",
				Icon: appIcon,
			},
		},
		// ---------------------------------------------------------------
		// Linux (GTK / WebKitGTK)
		// Transparency requires a compositor (Mutter, KWin, Hyprland, etc.).
		// If the compositor disables alpha, the window falls back to opaque.
		// ---------------------------------------------------------------
		Linux: &linux.Options{
			Icon:                appIcon,
			WindowIsTranslucent: true,
			WebviewGpuPolicy:    linux.WebviewGpuPolicyOnDemand,
			ProgramName:         "accidia",
		},
	})
	if err != nil {
		log.Fatalf("wails run: %v", err)
	}
}
