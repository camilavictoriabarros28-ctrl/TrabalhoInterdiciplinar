@echo off
chcp 65001 >nul
 title Organizze+ - Sistema Financeiro
 echo ============================================
 echo       ORGANIZZE+ - SISTEMA FINANCEIRO
 echo ============================================
 echo.
 where node >nul 2>nul
 if errorlevel 1 (
   echo Node.js nao encontrado.
   echo Instale a versao LTS em https://nodejs.org/ e abra este arquivo novamente.
   echo.
   pause
   exit /b 1
 )
 where npm >nul 2>nul
 if errorlevel 1 (
   echo npm nao encontrado. Reinstale o Node.js LTS.
   pause
   exit /b 1
 )
 if not exist "node_modules\express" goto instalar
 if not exist "node_modules\sql.js" goto instalar
 goto iniciar
 :instalar
   echo Instalando as dependencias. Isso acontece apenas na primeira vez...
   call npm install
   if errorlevel 1 (
     echo.
     echo A instalacao nao foi concluida. Confira sua conexao com a internet.
     pause
     exit /b 1
   )
 :iniciar
 echo.
 echo Iniciando o sistema...
 echo Quando aparecer o endereco, abra http://localhost:3000 no navegador.
 echo Para fechar o sistema, pressione Ctrl+C nesta janela.
 echo.
 call npm start
 pause
