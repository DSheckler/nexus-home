# NEXUS Home

**Panel de control del hogar para una tablet en la pared, con asistente de voz en español. Coste: 0 €.**

*A wall-mounted smart home dashboard for an old Android tablet: clock, weather, family calendar,
alarms, timers, shopping list, electricity prices and a Spanish voice assistant ("Oye NEXUS").
Runs entirely on Cloudflare's free tier. Built for Sweden (SMHI warnings, SE1–SE4 electricity prices).*

![Panel principal](docs/capturas/01-panel-principal.png)

## Qué hace

- **Diseño «Cristal»**: tarjetas de vidrio sobre un **cielo animado que sigue la hora y el tiempo real**
  (mañana, mediodía, atardecer, noche con estrellas fugaces, lluvia y nieve que caen). La lluvia o la nieve
  se confirman con las estaciones de SMHI más cercanas a tu casa, que se buscan solas. Va a 60 fps en una
  Galaxy Tab A de 2019.
- **Reloj, fecha y próxima alarma**.
- **Tiempo** (Open-Meteo) con detalle por horas y una **barra del sol**: amanecer, atardecer, horas de luz,
  cuántos minutos se ganan o se pierden mañana y la temperatura del día.
- **Avisos oficiales de SMHI en español**: los avisos amarillos, naranjas o rojos de tu zona aparecen arriba
  con su color; al tocarlos se ve qué va a pasar, cuándo y qué tener en cuenta (traducido una vez por aviso con
  Workers AI). También salen en el celular y en el resumen hablado.
- **Agenda familiar** de Google Calendar, interactiva: ver 14 días, filtrar por persona, agregar y quitar
  eventos. También para quien no tiene cuenta de Google (un niño).
- **Asistente de voz "Oye NEXUS"**: entiende y responde en español, crea alarmas, temporizadores y eventos,
  agrega cosas a la lista, deja notas, abre Spotify o YouTube.
- **Alarmas** con melodía suave que va creciendo, **temporizadores** con su propio sonido y rutina de
  buenos días: un resumen hablado con el tiempo, la agenda y recomendaciones (ropa, paraguas, luz barata).
- **Resumen de la mañana y de la noche a petición**: NEXUS no habla por su cuenta. Al despertar y las 2 horas
  antes del modo noche aparece un botón «Resumen de la mañana» / «Resumen de la noche» y se lee al tocarlo
  (o diciendo «Oye NEXUS, resumen del día»).
- **Precio real de la luz**: spot más red, impuesto, IVA y tu contrato, y aviso de la hora más barata para
  la lavadora.
- **Gasto de luz del mes** sin contador conectado: NEXUS lo estima con tu consumo habitual y el precio de
  cada hora. Cuando llega la factura, anotas los kWh del mes desde el celular y el cálculo queda exacto.
  Si el mes sale mucho más caro o más barato, la tarjeta dice por qué: el precio medio del mercado frente al
  mes anterior («Mercado ×2,1 vs octubre»).
- **Quién está en casa**: cada celular avisa al llegar o salir (Atajo del iPhone «Al llegar / Al salir» o botón
  «Llegué / Salí» del celular). Solo se guarda «en casa» o «fuera», nunca la ubicación. «Oye NEXUS, ¿ya llegó Ana?».
- **Recados al llegar**: «Oye NEXUS, cuando llegue Ana dile que pasó el cartero» (o desde el celular, marcando
  «Mostrarla cuando llegue a casa»). La nota aparece en el panel cuando esa persona llega.
- **Lista de compras que aprende**: NEXUS se fija cada cuánto piden cada cosa y sugiere «¿Se acabó? + leche».
- **Gasto del súper**: una foto de la boleta desde el celular y NEXUS suma el mes (Workers AI con visión, Mistral
  Small 3.1, dentro de la cuota gratuita). «Oye NEXUS, ¿cuánto llevamos en el súper?».
- **Recetas desde un enlace o una foto**: se abren paso a paso en el modo cocina de la tablet, traducidas al
  español si vienen en sueco o inglés. Las páginas con datos de receta (schema.org) no gastan IA.
- **Sensor de presencia** (app Android 1.7): la cámara frontal detecta movimiento en la propia tablet, sin guardar
  ni enviar imágenes. De noche sube un poco el brillo al acercarse; de día atenúa si no hay nadie. Se apaga en Casa.
- **Lista de compras y notas** compartidas desde el celular (sin instalar nada). Los cambios llegan al panel
  **al instante** (conexión en vivo por WebSocket), y una nota nueva suena con un aviso corto.
- **Notas de voz**: se graban desde el celular (hasta 1 minuto). En el panel aparecen como una tarjeta azul
  que se toca para escucharla. Se puede escuchar como máximo 2 veces y luego se borra sola (o antes, con «Quitar»).
- **Cumpleaños y aniversarios** (también los de los contactos del iPhone, exportando un archivo o con un Atajo: [guía](docs/atajo-cumpleanos.md)), rutinas ("me voy", "ya llegué", "buenas noches") y **modo noche**.
- **Recordatorios con hora** («recuérdame mañana a las 18 sacar la basura»): suenan en el panel.
- **Tareas de la casa** que se repiten (regar las plantas cada 3 días) con turnos que rotan solos.
- **Modo invitados**: un QR en el panel (o un enlace desde el celular) para que una visita use la lista
  y las notas durante 24 horas, sin ver nada más.
- **Resumen de la semana** el domingo por la tarde (botón «Resumen de la semana»): agenda, cumpleaños, basura, tareas, tiempo y luz.
- **Aviso de luz barata o cara** en el panel y **comparación** del gasto con el contrato anterior.
- **Menú de la semana** (panel, celular y voz) que pasa los ingredientes a la lista, y **modo cocina**: la receta
  paso a paso a pantalla completa, manejada por voz («siguiente», «repite», «pon el temporizador»).
- **Plantas**: tarjeta con el próximo riego en días fijos (p. ej. cada dos domingos).
- **Recordatorios que se repiten** («recuérdame cada lunes a las 8 sacar el cartón»).
- **Suecia**: festivos, cambio de hora, neumáticos de invierno y día del detector de humo.
- **Aurora boreal** (índice Kp de NOAA y nubosidad), **polen, calidad del aire y UV** (Open-Meteo).
- **Colegio**: horario y qué llevar cada día; **hora de la familia en otro país**; **modo vacaciones**.
- **Casa**: luces y enchufes Shelly (opcional).

| | |
|---|---|
| ![De noche, con aviso de SMHI](docs/capturas/15-modo-noche.png) | ![Aviso de SMHI](docs/capturas/20-aviso-smhi.png) |
| ![Menú de la semana](docs/capturas/19-menu-semana.png) | ![Barra del sol](docs/capturas/02-tiempo-interactivo.png) |
| ![Celular de día](docs/capturas/16-iphone-compra-y-notas.png) | ![Celular en modo oscuro](docs/capturas/21-iphone-oscuro.png) |

Más capturas en [`docs/capturas`](docs/capturas).

## Cómo está montado

```
Tablet (app Android mínima)  ──HTTPS──>  Cloudflare Worker  ──>  Open-Meteo, SMHI (tiempo y avisos)
  página web a pantalla completa          src/  (servidor)  ──>  elprisetjustnu.se (precio de la luz)
  micrófono, alarmas, sonidos             public/ (panel)   ──>  Google Calendar (cuenta de servicio)
                                          KV (datos)        ──>  Workers AI: Whisper (voz → texto),
                                          Durable Object (avisos en vivo)
Celular (navegador) ── lista y notas                                gpt-oss-120b (asistente), Aura-2 (voz)
```

- **Las claves nunca están en la tablet ni en el código.** Se guardan como *secrets* de Cloudflare.
  La tablet solo guarda un código de emparejamiento, que puedes revocar.
- **Lo barato primero:** las preguntas habituales (hora, tiempo, temporizadores, lista, luz…) se
  responden sin IA. Así la cuota gratuita diaria de Workers AI dura mucho más.
- **Tolerancia a fallos:** si se acaba la cuota, se usa la voz de la tablet. Si falla Google, el resto
  del panel sigue funcionando. Sin Google configurado, arranca con una agenda de ejemplo.

| Carpeta | Qué es |
|---|---|
| `public/` | Panel: `index.html`, `css/app.css`, `js/` (`app.js`, `home.js`, `alarms.js`, `agenda.js`, `voice.js`, `wake.js`…) y `movil.html` |
| `src/` | Servidor: `index.js` (rutas y seguridad), `config.js` (tu casa), `assistant.js`, `quick.js`, `calendar.js`, `extras.js`, `household.js`… |
| `android/` | App de quiosco (`MainActivity.java`) y `build.ps1` para compilarla sin Android Studio |

## Instalación

Necesitas una cuenta gratuita de [Cloudflare](https://dash.cloudflare.com/sign-up) y [Node.js](https://nodejs.org) 20 o más reciente.

1. **Descarga e instala las dependencias**
   ```powershell
   git clone <este repositorio>; cd nexus-home; npm install; npx wrangler login
   ```
2. **Crea tu almacén de datos** y pon el `id` que te devuelve en `wrangler.jsonc` (`kv_namespaces`):
   ```powershell
   npx wrangler kv namespace create NEXUS_KV
   ```
3. **Crea dos claves**: una para la tablet y otra para los celulares. Ejecuta este comando dos veces:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```
   Guárdalas en Cloudflare:
   ```powershell
   npx wrangler secret put NEXUS_TOKEN
   ```
   ```powershell
   npx wrangler secret put FAMILY_TOKEN
   ```
4. **Configura tu casa**: copia `nexus-home.example.json`, cambia la ciudad, las coordenadas, la zona de
   precio (SE1–SE4), los nombres de la familia, tu contrato de luz, la cuota fija de la red al mes
   (`gridMonthlyKr`) y tu consumo anual aproximado (`yearKwh`). Pega el JSON (en una línea) en:
   ```powershell
   npx wrangler secret put NEXUS_HOME
   ```
5. **Publica**
   ```powershell
   npx wrangler deploy
   ```
6. **Abre el panel** en la tablet: `https://<tu-worker>.workers.dev/#token=<NEXUS_TOKEN>`. La clave se
   guarda en la tablet y desaparece de la dirección. En el celular:
   `https://<tu-worker>.workers.dev/movil.html#k=<FAMILY_TOKEN>`, y después *Agregar a pantalla de inicio*.

### Opcional: Google Calendar
1. En [Google Cloud](https://console.cloud.google.com) crea un proyecto, activa la **Google Calendar API**
   y crea una **cuenta de servicio** con una clave JSON.
2. Cada persona comparte su calendario con el correo de la cuenta de servicio (permiso *Hacer cambios
   en eventos*).
3. Guarda los dos secretos:
   - `GOOGLE_SA`: el contenido del JSON;
   - `GOOGLE_CALENDARS`: `[{"who":"ana","name":"Ana","color":"#6fa8dc","id":"ana@gmail.com"}, …]`.

   Para alguien sin cuenta de Google, agrega `"host":"ana"` y el `id` del calendario de esa persona
   anfitriona.
4. Los cambios hechos en Google Calendar llegan al panel en segundos: NEXUS se suscribe a los avisos
   de Google (`events.watch`) la primera vez que se abre la agenda, y una tarea diaria los renueva.
   Estado: `GET /api/gcal/watch`.

### Opcional: app Android de quiosco
Mantiene la pantalla encendida, da permiso de micrófono y abre el panel a pantalla completa.
1. Crea estos archivos (están excluidos de git):
   - `android/host.txt`, con la dirección de tu Worker;
   - `secrets/keystore-pass.txt`, con una contraseña para la clave de firma.
2. Compila la app (necesita el JDK 17 y las *build-tools* del SDK de Android):
   ```powershell
   powershell -ExecutionPolicy Bypass -File android\build.ps1
   ```
3. Instala `android\nexus.apk` en la tablet con `adb install -r`.

La app también reproduce el sonido (voz, alarmas, avisos) con el reproductor nativo de Android y
trae la voz de Google del sistema, gratis, para los textos largos y cuando se acaba la cuota de IA.
Es importante en algunas tablets: con **Android 11 y WebView 140** (comprobado en una Galaxy Tab A
SM-T515) la salida de audio de la página se corta a los pocos milisegundos y vuelve a abrirse sin
parar. La voz sale a trozos y el micrófono graba audio deformado, con lo que el asistente «oye»
cosas que nadie ha dicho. Para saber si te pasa, mira en `adb logcat` si aparece
`AudioStreamLegacy: ... DISCONNECT ... due to device change` al sonar algo. Con la app 1.5 o
posterior queda resuelto: el panel usa el reproductor nativo y lee el micrófono sin pasar por esa salida.

### Opcional: luces Shelly
En la app Shelly Smart Control, ve a *Ajustes de usuario → Authorization cloud key*. Guarda la clave y el
servidor como secretos `SHELLY_AUTH_KEY` y `SHELLY_SERVER`. Después registra los dispositivos con
`PUT /api/devices`.

## Uso diario

- **Publicar un cambio:** sube `VERSION` en `src/index.js` y ejecuta `npx wrangler deploy`. La tablet se
  recarga sola.
- **Probar en el PC:** copia `.dev.vars.example` como `.dev.vars`, ejecuta `npm run dev` y abre
  `http://localhost:8787/#token=<tu NEXUS_TOKEN de .dev.vars>`.
- **Ver el cielo a otra hora o con otro tiempo:** agrega `?cielo=21:30` y/o `?clima=sun|partly|cloudy|rain|snow`
  a la dirección del panel (solo cambia el fondo, para probar).
- **Probar los avisos de SMHI sin esperar a una tormenta:** pon `WARN_TEST_POINT=lat,lon` en `.dev.vars`
  con un punto dentro de un aviso activo (mira el mapa en smhi.se). En local no hay Workers AI, así que el
  texto sale en inglés; en Cloudflare se traduce.
- **Cambiar la voz:** cambia `TTS_VOICE` en `wrangler.jsonc`. Por defecto `carina`.
  Otras: selena, aquila (latinoamericanas), sirio, estrella, javier (mexicanas), celeste (colombiana) y nestor,
  alvaro, diana (de España, como carina).
- **Salir al sistema en la tablet:** mantén presionada la fecha 3 segundos.
- **Modo noche** («Cristal de noche»: cielo casi negro con estrellas quietas, reloj en luz de luna, alarma, tiempo de mañana y fase de la luna; brillo al 3 %): de domingo a jueves desde las 22:00, y los viernes y sábados desde las 00:00. Despierta a
  las 07:00 entre semana y a las 08:00 el fin de semana. El horario está en `public/js/app.js`
  (`NIGHT_START` / `NIGHT_END`). Los botones de resumen salen en `briefingSlot()` del mismo archivo.
- **Cuota gratuita de IA:** 10.000 neuronas al día, que se reinician a las 00:00 UTC. Desde el 70 % aparece
  un aviso en el panel.

## Montaje en la pared

- **Altura:** a la de los ojos de pie (unos 140–155 cm al centro), cerca de un enchufe.
- **Ubicación:** a menos de 2–3 m de donde se habla, y lejos del sol y de fuentes de calor.
- **Ventilación:** deja libres los altavoces y el micrófono, y algo de aire detrás.
- **Carga:** usa un cargador de pared de 5 V / 2 A y un cable USB-C largo. Si la tablet lo permite, activa
  *Proteger batería* (carga al 85 %).
- **Mantenimiento:** revisa de vez en cuando que la batería no se hinche.

## Licencia

[MIT](LICENSE). Úsalo, cámbialo y compártelo.
