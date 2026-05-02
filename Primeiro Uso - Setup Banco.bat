@echo off
title RB24Horas - Setup inicial do banco
color 0B
echo.
echo  =============================================
echo   RB24Horas - Configuracao inicial do banco
echo  =============================================
echo.
echo  Este script cria as tabelas e insere os
echo  dados iniciais no PostgreSQL Docker.
echo.
echo  Execute APENAS na primeira vez, ou para
echo  resetar o banco de dados.
echo.
pause

:: ── Verificar Docker rodando ──────────────────────────────────────────────────
docker info >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERRO] Docker nao esta rodando.
    echo         Execute "Iniciar Sistema.bat" primeiro.
    pause & exit /b 1
)

:: ── Subir banco se não estiver rodando ────────────────────────────────────────
echo  [DB] Iniciando PostgreSQL...
cd /d "%~dp0"
docker-compose up -d >nul 2>nul

:: ── Aguardar PostgreSQL ───────────────────────────────────────────────────────
echo  [DB] Aguardando banco ficar pronto...
:aguardar
docker exec rb24horas_db pg_isready -U rb24user -d rb24horas >nul 2>nul
if %errorlevel% neq 0 (
    timeout /t 2 /nobreak >nul
    goto aguardar
)
echo  [DB] Banco pronto!

:: ── Rodar setup ───────────────────────────────────────────────────────────────
echo  [SETUP] Criando tabelas e dados iniciais...
echo.
cd /d "%~dp0backend"
node db/setup.js

echo.
echo  =============================================
echo   Setup concluido! Agora execute:
echo   "Iniciar Sistema.bat"
echo  =============================================
echo.
pause
