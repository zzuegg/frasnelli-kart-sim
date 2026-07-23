# Frasnelli Kart Sim

Ein lokal laufender 3D-Kart-Prototyp für den Frasnelli Karting Parc. Die 1.018,3 m lange georeferenzierte OSM-Mittellinie liegt auf einem amtlichen LiDAR-Höhenmodell; der Betreiber nennt 1.030 m Streckenlänge.

## Start

```powershell
pnpm install
pnpm dev
```

Danach `http://127.0.0.1:5173` in Chrome oder Edge öffnen.

## Steuerung

- Tastatur: `W/S` Gas/Bremse, `A/D` lenken, `I` KI-Fahrer ein/aus, `R` zurücksetzen, `C` Kamera wechseln, `P` Pause
- Logitech G923: in Logitech G HUB und im Spiel denselben Lenkradbereich einstellen (**270° empfohlen**), anschließend **G923 kalibrieren** auswählen und Lenkrad/Pedale den erkannten Achsen zuordnen.

Die Browser-Gamepad-API unterstützt Lenkrad- und Pedaleingaben. TrueForce bzw. echtes Lenkmoment benötigt eine native Logitech-SDK-Anbindung und steht in dieser Web-Version nicht zur Verfügung. Falls der Browser einen Haptik-Aktuator meldet, überträgt das Spiel Kerbs, Reifenschlupf, blockierende Hinterräder und Einschläge als abgestuftes Rumble.

## Mobile Steuerung

Im Hauptmenü **Mobile-Steuerung** einschalten. Der linke Daumen lenkt links/rechts, der rechte Daumen steuert mit oben Gas und unten Bremse. Der Button oben setzt das Kart jederzeit zurück.

## Fahrphysik

Das Modell bildet den **Birel ART N35-XR ST** ab: 140 kg Kartmasse, 1.070 mm Radstand, 1.208/1.410 mm Vorder-/Hinterachsbreite, 40×5×1.060-mm-Starrachse, hydraulische Hinterachs-Scheibenbremse, 340-mm-Lenkrad sowie harte Mitas-SRH/Duro-Mietkartreifen. Physics V3 berechnet vier Radlasten und Raddrehzahlen, Ackermann-Lenkung, eine kombinierte Reifenellipse mit transientem Kraftaufbau, dynamische Chassisverwindung und Hinterradentlastung, Fahrerbewegung, Kupplungs-/Motorträgheit, Bremstemperatur sowie Reifenluftdruck, Temperatur und Verschleiß. Das Höhenmodell und die sägezahnförmigen Kerbs wirken einzeln auf jedes Rad.

## Bestzeit-Ghost

Die schnellste gültige manuelle Runde wird automatisch im Browser gespeichert und nach einem Neuladen wiederhergestellt. Der halbtransparente Ghost startet bei jeder neuen Runde erneut. Im HUD lässt er sich ein- und ausblenden; mit **Vorsprung** wird seine Wiedergabe um 0–10 Sekunden vorgezogen. Taste `G` schaltet ihn direkt um. Die farbige Optimallinie lässt sich unabhängig davon per HUD-Option oder Taste `L` ein- und ausblenden; auch diese Einstellung bleibt gespeichert.

Die N35-Baureihe kann laut Hersteller mit Honda GX200, GX270 oder GX390 sowie trockener oder nasser Kupplung ausgerüstet werden. Frasnelli veröffentlicht die konkrete Motor-/Übersetzungsvariante nicht; Motorkennlinie und Übersetzung bleiben daher vorläufig auf GX390-Niveau kalibriert. Für die letzte Abstimmung werden Motorvariante oder GPS-Geschwindigkeit einer realen Runde benötigt.

Fahrzeugquelle: https://www.birelart.com/assets/elfinder-2/files/download/brochure/rental_gasoline_v4%20web.pdf

## Online-Version

Die Web-Version funktioniert statisch auf GitHub Pages. Neue Runden werden weiterhin lokal im Browser gespeichert. Die serverseitig gestartete KI-Optimierung funktioniert hingegen nur im lokalen Vite-Entwicklungsserver.

## Referenz-Ghost

Die mitgelieferte Referenzrunde (0:57,667) ist der anfängliche Ghost. Eine persönliche Bestzeit ersetzt sie nur im selben Browser und nur, wenn sie schneller ist. Der veröffentlichte Referenzdatensatz enthält keine Namen, Gerätekennung oder Zeitstempel.

## KI-Fahrer und gefahrene Bestlinie

`pnpm ai:train` lässt mehrere KI-Piloten parallel in einem Worker-Pool im vollständigen N35-Physikmodell jeweils eine Einroll- und eine fliegende Runde fahren. Standardmäßig werden bis zu acht CPU-Threads genutzt und mindestens zwei logische CPUs für Spiel und Browser freigelassen; mit `AI_WORKERS=4` lässt sich das begrenzen. Nur gültige Runden ohne Gras- oder Leitplankenkontakt werden gewertet. Der globale Trainingsstand liegt in `.ai-training/global-racing-line-data.js`, außerhalb des von Vite überwachten Spiels.

Die globale Suche verwendet **keine menschliche Fahrlinie**. Sie startet von der georeferenzierten Streckenmitte und entwickelt in 48 kontinuierlich interpolierten Sektoren seitlichen Versatz, Kurvenradius, Bremspunkte und Zielgeschwindigkeit gemeinsam weiter. Für eine reife Population werden kleine, über Nachbarsektoren geglättete Mutationen und lokale Controller-Varianten getestet; bei einem Plateau vergrößert der Optimierer den Suchradius automatisch. Jede Variante wird im vollständigen Kartmodell gefahren; nur eine tatsächlich gültige fliegende Runde kann die Population verbessern.

Manuelle Bestzeiten bleiben für Ghost und Vergleich persistent gespeichert, beeinflussen die KI-Optimierung aber nicht. Sobald ein Ghost vorhanden ist, lässt er sich im Hauptmenü als vollständiges Replay mit Verfolger- oder Cockpitkamera ansehen; `Esc` beendet die Wiedergabe. Curbs zählen wie im Spiel als gültige Fahrbahn; Gras- und Leitplankenkontakte bleiben ungültig.

`pnpm ai:optimize` führt mehrere globale Generationen hintereinander aus und stoppt beim Ziel 0:57,5, nach acht Generationen ohne relevante Verbesserung oder nach 20 Generationen. Der Vite-Spielserver läuft davon getrennt weiter, sodass während der Offline-Suche ohne Neustarts gefahren werden kann. Erst `pnpm ai:apply` übernimmt den schnellsten vorhandenen Trainingsstand ins Spiel und verursacht dabei genau einen Reload.

Im Spiel zeigt die Linie genau diese Fahrt: Grün bedeutet Gas, Gelb Rollen und Rot Bremsen. **KI-Runde fahren** startet die fahrbare Wiedergabe; die HUD-Zeit **KI-Bestzeit** ist die schnellste Trainingsrunde bei 70 kg Fahrergewicht.

## Geodaten und 3D-Profil

- Hochauflösendes DTM: **Digitales Geländemodell Etsch 2024, 0,2 m**, amtlicher WCS der Autonomen Provinz Bozen. Es deckt 447 der 1.018 Strecken-Samples ab.
- Lückenfüller: amtliches **DTM 0,5 m der Siedlungsgebiete**. Beide Raster werden in EPSG:25832 verarbeitet.
- Streckenmitte und Start/Ziel: OpenStreetMap-Way `208383998`, Startknoten `2186826134` (ODbL).
- Ermitteltes Höhenprofil: 233,774–237,339 m, also 3,565 m Unterschied. Das 3D-Modell verwendet die Rasterhöhe auch an beiden Fahrbahnrändern, sodass Steigung und Querneigung sichtbar sind und in die Kartlage einfließen.

Die passende amtliche Quelle ist hier ein **20-cm-Raster**, nicht 3 cm. Die 50-cm-Daten ergänzen den nicht vom Etsch-2024-Flugstreifen erfassten Teil.

Quellen:

- https://natur-raum.provinz.bz.it/de/digitale-hohenmodelle
- https://geoservices9.civis.bz.it/geoserver/ows?service=WCS&version=2.0.1&request=GetCapabilities
- https://geodati.gov.it/resource/id/p_bz%3AElevation%3ADigitalTerrainModel-0.5m
- https://www.openstreetmap.org/copyright

## Terrain neu erzeugen und prüfen

Die lokalen Quelldateien `frasnelli-dtm-20cm.tif`, `frasnelli-dtm-50cm.tif` und `frasnelli-osm-map.xml` werden mechanisch in `src/generated/terrain-data.js` umgewandelt:

```powershell
pnpm terrain:build
pnpm ai:train
pnpm test:physics
pnpm test:ai
pnpm build
```
