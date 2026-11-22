# Compila la app NEXUS (APK) sin Android Studio ni Gradle.
# Uso: powershell -ExecutionPolicy Bypass -File android\build.ps1
# Necesita (fuera de git):
#   android\host.txt             -> dirección de tu Worker, p. ej. nexus-home.tu-cuenta.workers.dev
#   secrets\keystore-pass.txt    -> contraseña de la clave de firma (o la variable NEXUS_KS_PASS)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot

$hostFile = "$here\host.txt"
if (-not (Test-Path $hostFile)) { throw "Falta android\host.txt con la dirección de tu Worker (p. ej. nexus-home.tu-cuenta.workers.dev)" }
$nexusHost = (Get-Content $hostFile -Raw).Trim() -replace '^https?://', '' -replace '/.*$', ''
if ($nexusHost -notmatch '^[a-z0-9.-]+$') { throw "android\host.txt no contiene una dirección válida" }
if (-not $env:NEXUS_KS_PASS) {
  $passFile = "$here\..\secrets\keystore-pass.txt"
  if (Test-Path $passFile) { $env:NEXUS_KS_PASS = (Get-Content $passFile -Raw).Trim() }
  else { $env:NEXUS_KS_PASS = Read-Host "Contraseña para la clave de firma (mín. 6 caracteres)" }
}
$jdk = "$env:LOCALAPPDATA\Programs\devtools\jdk-17.0.20.1+1"
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$bt = "$sdk\build-tools\35.0.0"
$jar = "$sdk\platforms\android-35\android.jar"
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"

$out = "$here\build"
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$out\res", "$out\gen", "$out\classes", "$out\dex" | Out-Null

# Icono (a partir del icono del panel web)
New-Item -ItemType Directory -Force "$here\res\mipmap-xhdpi" | Out-Null
Copy-Item "$here\..\public\icons\icon-192.png" "$here\res\mipmap-xhdpi\ic_launcher.png" -Force

# 1. Recursos y manifiesto
& "$bt\aapt2.exe" compile --dir "$here\res" -o "$out\res.zip"
& "$bt\aapt2.exe" link -o "$out\base.apk" -I $jar --manifest "$here\AndroidManifest.xml" --java "$out\gen" "$out\res.zip" --auto-add-overlay
if ($LASTEXITCODE) { throw "aapt2 link falló" }

# 2. Java -> clases -> dex (copia del código con la dirección del Worker puesta)
Copy-Item "$here\src" "$out\src" -Recurse
$main = Get-ChildItem "$out\src" -Recurse -Filter MainActivity.java | Select-Object -First 1
[IO.File]::WriteAllText($main.FullName, ([IO.File]::ReadAllText($main.FullName) -replace 'NEXUS_HOST_PLACEHOLDER', $nexusHost))
$src = Get-ChildItem "$out\src", "$out\gen" -Recurse -Filter *.java | ForEach-Object { $_.FullName }
# Las lambdas necesitan java.lang.invoke del JDK; d8 las convierte para Android
$ErrorActionPreference = "Continue"
& javac -nowarn --release 11 -classpath $jar -d "$out\classes" @src 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -notmatch '^Note:' }
if ($LASTEXITCODE) { throw "javac falló" }
$ErrorActionPreference = "Stop"
$classes = Get-ChildItem "$out\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& "$bt\d8.bat" --release --min-api 26 --lib $jar --output "$out\dex" $classes
if ($LASTEXITCODE) { throw "d8 falló" }

# 3. Añadir classes.dex al APK
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$out\base.apk", "Update")
[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$out\dex\classes.dex", "classes.dex") | Out-Null
$zip.Dispose()

# 4. Alinear y firmar (clave local propia, guardada fuera de git)
& "$bt\zipalign.exe" -f -p 4 "$out\base.apk" "$out\aligned.apk"
$ks = "$here\..\secrets\nexus-release.jks"
if (-not (Test-Path $ks)) {
  $ErrorActionPreference = "Continue"
  & keytool -genkeypair -keystore $ks -alias nexus -keyalg RSA -keysize 2048 -validity 10000 `
    -storepass:env NEXUS_KS_PASS -keypass:env NEXUS_KS_PASS -dname "CN=NEXUS Home" 2>&1 | Out-Null
  $ErrorActionPreference = "Stop"
}
& "$bt\apksigner.bat" sign --ks $ks --ks-pass env:NEXUS_KS_PASS --key-pass env:NEXUS_KS_PASS --out "$here\nexus.apk" "$out\aligned.apk"
if ($LASTEXITCODE) { throw "apksigner falló" }
& "$bt\apksigner.bat" verify "$here\nexus.apk"
"APK listo: $here\nexus.apk ($([math]::Round((Get-Item "$here\nexus.apk").Length / 1KB)) KB)"
