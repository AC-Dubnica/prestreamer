---
title: Riešenie problémov
lang: sk
---

[← Domov](index.md) · [English](../troubleshooting.md)

# Riešenie problémov

Nájdite príznak, vyskúšajte prvé riešenie a potom ďalšie.

## Obrazovky a snímky

| Problém | Riešenie |
| --- | --- |
| Snímka sa na obrazovke nezobrazuje | Je obrazovka **otvorená** (červená bodka na jej karte)? Stlačte na nej **Otvoriť** alebo **Otvoriť všetky obrazovky**. |
| Obrazovka sa otvorila na nesprávnom monitore | **Nastavenia → Obrazovky → Upraviť…** pri danej obrazovke: zvoľte displej. **Označiť displeje** ukáže číslo každého monitora. |
| Živá obrazovka zakrýva ovládacie prvky | Pripojili ste obrazovku k displeju, na ktorom je okno operátora. Stlačte **Esc** a danú obrazovku zatvorte, alebo ju pripojte k inému displeju. |
| Text je príliš malý alebo príliš veľký | ⚙ na obrazovke: **Veľkosť písma**. Skontrolujte na skutočnej obrazovke. |
| Obrázok alebo video za textom chýba | Je v ⚙ danej obrazovky zaškrtnuté **Pozadia snímok**? Skontrolujte pozadia piesne, snímky a pozadia celej aplikácie ([médiá](media.md#pozadia)). |
| Snímky prezentácie vyzerajú inak ako originál | Exportujte PDF z programu, v ktorom ste ju vytvorili, a importujte ho ([médiá](media.md#prezentacie-a-obrazky)). |
| Video sa neprehráva alebo sa zasekne pri konverzii | Počkajte na stavový riadok pod programom. Veľmi dlhý alebo nezvyčajný súbor môže trvať minúty. Videá importujte pred bohoslužbou. |

## Prenos

| Problém | Riešenie |
| --- | --- |
| *Spustiť vysielanie* je sivé alebo hlási chýbajúci kľúč | **Nastavenia → Prenos**: zvoľte *Vysielať na YouTube* a vložte kľúč. |
| Hlási, že vysiela, ale YouTube nič neukazuje | Otvorte vysielanie v YouTube Studio: pre vysielanie s daným kľúčom musí byť zapnuté *automatické spustenie*. Skontrolujte, že kľúč je aktuálny. |
| Veľa vynechaných snímok, nízky dátový tok | Odosielanie je príliš pomalé: znížte dátový tok alebo rozlíšenie, použite kábel ([vysielanie](streaming.md#sledovanie-stavu-prenosu)). |
| Prenos nemá zvuk | Je mixér zapnutý a nestlmený? Panel Prenos upozorní, keď je vypnutý. Skontrolujte fáder a ukazovateľ masteru na karte Mixér. |
| Slová treba z prenosu odstrániť okamžite | **Ikona kamery** (iba kamera) v paneli Prenos. |

## Zvuk

| Problém | Riešenie |
| --- | --- |
| Zvukové rozhranie nie je v zozname | Pripojte ho pred spustením a potom znova otvorte kartu Mixér. Na Macu povoľte prístup k **mikrofónu** v Nastaveniach systému → Súkromie a zabezpečenie. |
| Pri viackanálovom pulte sa zobrazujú len dva kanály | Pult sa môže hlásiť ako stereo, kým sa nenastaví jeho režim USB; skontrolujte nastavenia USB pultu. Vo Windowse sa pult, ktorý dáva kanály len cez vlastný ovládač ASIO, nedá čítať. |
| Linux: karta je „používaná“ | Kartu drží iný zvukový program (PipeWire, PulseAudio). Dajte ju ALSA, alebo použite dvojkanálový vstup. |
| Zvuk videa je počuť dvakrát | Stlmte kanály *Video L / R*, ak váš pult v sále posiela zvuk videa späť do počítača ([zvuk](sound.md#tri-zvuky)). |
| Spätná väzba (pískanie) | **Odposluch** hrá tam, kde ho počuje mikrofón. Vypnite ho alebo presuňte na slúchadlá. |
| Hlas a obraz nie sú synchronizované | Pridajte na master **synchronizačné oneskorenie** (začnite približne na 150 ms a upravte). |

## ATEM, NDI a svetlá

| Problém | Riešenie |
| --- | --- |
| Chýba panel ATEM | Pult musí odpovedať: skontrolujte ethernetový kábel, adresu v **Nastavenia → ATEM** a či je počítač v rovnakej sieti ([ATEM](atem.md)). |
| Obrazovka NDI hlási chýbajúcu knižnicu | Nainštalujte **NDI Tools** alebo **NDI Runtime** z ndi.video ([NDI](ndi.md)). |
| Chýba panel DMX | Musí byť zaškrtnuté **Nastavenia → DMX → Používať DMX**. Ďalšie problémy so svetlami: pozrite [tabuľku riešenia problémov DMX](dmx.md#riesenie-problemov). |

## Kde sa čo ukladá

Aplikácia ukladá piesne, bohoslužby, obrazovky, mixér a nastavenia do svojho dátového priečinka: `~/Library/Application Support/prestreamer` na Macu, `%APPDATA%\prestreamer` vo Windowse a `~/.config/prestreamer` v Linuxe. Skopírujte ho, ak chcete zálohu alebo presun na iný počítač.

## Nahlásenie problému

[Otvorte issue](https://github.com/AC-Dubnica/prestreamer/issues) s tým, čo ste urobili, čo ste očakávali, čo sa stalo, a s verziou (je v názve súboru inštalátora). Pomôže snímka obrazovky. **Nikdy nepridávajte kľúč prenosu.**
