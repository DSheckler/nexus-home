# Cumpleaños del iPhone a NEXUS

## La forma fácil: exportar los contactos (sin Atajo)

1. En la app **Contactos** (iOS 16 o posterior), toca **Listas** arriba a la izquierda.
2. Mantén presionada la lista (por ejemplo **Todos los contactos** o **iCloud**) → **Exportar** →
   **Guardar en Archivos**. Se guarda un archivo `.vcf`.
3. Abre NEXUS en el celular → abajo, **Importar cumpleaños de Contactos (archivo .vcf)** → elige el archivo.

El archivo se lee en el propio celular: a NEXUS solo llegan los nombres y las fechas de cumpleaños.
Repítelo cuando agregues cumpleaños nuevos; cada importación sustituye a la anterior.

## La forma automática: un Atajo (app Atajos)

El calendario «Cumpleaños» del iPhone sale de los Contactos y no se puede compartir. Este Atajo
lee los contactos que tienen cumpleaños y los envía a NEXUS. Se puede repetir cuando quieras:
cada envío sustituye al anterior (las fechas guardadas a mano en NEXUS no se tocan).

Los cumpleaños importados aparecen en la agenda y en el panel cuando faltan 7 días o menos,
y NEXUS avisa el día antes y el mismo día.

## Crear el Atajo (una sola vez)

1. Abre **Atajos** → **+** (nuevo atajo) y llámalo «Cumpleaños a NEXUS».
2. Agrega **Buscar contactos**. Toca «Agregar filtro» y elige **Cumpleaños** → **tiene cualquier valor**.
3. Agrega **Repetir con cada** (sobre los contactos encontrados). Dentro:
   1. **Formatear fecha**: fecha = *Elemento repetido → Cumpleaños*; formato **Personalizado**,
      cadena `yyyy-MM-dd`.
   2. **Texto**: *Elemento repetido → Nombre* `;` *Fecha formateada*
      (queda como `Ana García;1990-05-03`).
4. Después del bloque, agrega **Combinar texto** (de *Resultados de Repetir*) con **Nueva línea**.
5. Agrega **Obtener contenido de URL**:
   - URL: `https://<tu-worker>.workers.dev/api/dates/import`
   - Método: **POST**
   - Encabezados: `Authorization` = `Bearer <tu clave de familia>` (la que va después de `k=`
     en el enlace del celular)
   - Cuerpo de la solicitud: **Archivo** → *Texto combinado*
6. Agrega **Mostrar resultado** para ver cuántos se importaron.

Toca ▶. La primera vez el iPhone pedirá permiso para leer los contactos y para conectarse a tu Worker.

## Que se actualice solo

**Atajos → Automatización → + → Hora del día** → por ejemplo el día 1 de cada mes a las 10:00 →
**Ejecutar inmediatamente** → acción **Ejecutar atajo** «Cumpleaños a NEXUS».

Consejo: si no quieres los cumpleaños de todos tus contactos, crea un grupo de contactos (por
ejemplo «Familia») y agrega en el paso 2 el filtro **Grupo** es «Familia».
