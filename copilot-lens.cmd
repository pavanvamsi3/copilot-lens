@echo off
for /f "tokens=*" %%i in ('fnm env --use-on-cd') do call %%i
node "%~dp0dist\cli.js" %*
