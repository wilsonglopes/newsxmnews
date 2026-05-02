@echo off
title RB24Horas - Sistema
color 0A
echo.
echo  =============================================
echo   RB24Horas - Iniciando sistema...
echo  =============================================
echo.

:: ── Verificar Node.js ────────────────────────────────────────────────────────
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERRO] Node.js nao encontrado.
    echo         Instale em: https://nodejs.org
    pause & exit /b 1
)

:: ── Verificar Docker ─────────────────────────────────────────────────────────
where docker >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERRO] Docker nao encontrado.
    echo         Instale em: https://docs.docker.com/desktop/windows/
    pause & exit /b 1
)

:: ── Verificar se Docker Desktop esta rodando ──────────────────────────────────
docker info >nul 2>nul
if %errorlevel% neq 0 (
    echo  [INFO] Iniciando Docker Desktop...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe" >nul 2>nul
    echo  Aguardando Docker inicializar ^(pode demorar ate 60 segundos^)...
    :aguardar_docker
    timeout /t 5 /nobreak >nul
    docker info >nul 2>nul
    if %errorlevel% neq 0 goto aguardar_docker
    echo  [INFO] Docker pronto!
)

:: ── Subir banco de dados PostgreSQL via Docker ────────────────────────────────
echo  [DB] Iniciando PostgreSQL...
cd /d "%~dp0"
docker-compose up -d >nul 2>nul
if %errorlevel% neq 0 (
    echo  [AVISO] Falha ao subir container. Tentando continuar...
)

:: ── Aguardar PostgreSQL ficar pronto ──────────────────────────────────────────
echo  [DB] Aguardando PostgreSQL ficar pronto...
set MAX_WAIT=30
set WAIT=0
:aguardar_db
docker exec rb24horas_db pg_isready -U rb24user -d rb24horas >nul 2>nul
if %errorlevel% == 0 goto db_pronto
set /a WAIT+=1
if %WAIT% geq %MAX_WAIT% (
    echo  [AVISO] Banco demorou demais. Verifique o Docker e tente novamente.
    pause & exit /b 1
)
timeout /t 2 /nobreak >nul
goto aguardar_db

:db_pronto
echo  [DB] PostgreSQL pronto!

:: ── Setup do banco (tabelas + dados iniciais) — seguro rodar sempre ───────────
echo  [SETUP] Verificando tabelas e dados iniciais...
cd /d "%~dp0backend"
node db/setup.js
if %errorlevel% neq 0 (
    echo  [ERRO] Falha no setup do banco. Verifique o arquivo .env
    pause & exit /b 1
)

:: ── Instalar dependencias se node_modules nao existir ─────────────────────────
if not exist "node_modules" (
    echo  [NPM] Instalando dependencias...
    npm install
)

:: ── Matar processos Node anteriores na porta 3000 ─────────────────────────────
echo  [API] Liberando porta 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 " 2^>nul') do (
    taskkill /PID %%a /F >nul 2>nul
)
timeout /t 1 /nobreak >nul

:: ── Abrir painel no navegador apos 4s ─────────────────────────────────────────
start /b cmd /c "timeout /t 4 /nobreak >nul && start http://localhost:3000"

:: ── Iniciar backend ───────────────────────────────────────────────────────────
echo.
echo  -----------------------------------------------
echo   [OK] Sistema iniciado com sucesso!
echo   Painel: http://localhost:3000
echo   Para parar: feche esta janela
echo  -----------------------------------------------
echo.
node server.js

pause
