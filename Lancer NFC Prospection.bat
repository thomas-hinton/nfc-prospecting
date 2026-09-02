@echo off
title NFC Prospection - Serveur local
cd /d "%~dp0"

echo.
echo   NFC Prospection est en cours de lancement...
echo   Laissez cette fenetre ouverte pendant l'utilisation.
echo   Fermez cette fenetre pour arreter l'application.
echo.

start "" /b py -3 server.py
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173/"

echo NFC Prospection est ouverte dans votre navigateur.
echo.
rem Cette boucle maintient la fenetre ouverte ; la fermer arrete aussi le serveur.
:wait
timeout /t 60 /nobreak >nul
goto wait
