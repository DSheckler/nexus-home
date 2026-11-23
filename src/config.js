// Configuración de cada casa. Los valores reales NO van en el código: se guardan como
// secreto de Cloudflare en formato JSON:
//   npx wrangler secret put NEXUS_HOME
//   {"city":"Göteborg","lat":57.7089,"lon":11.9746,"zone":"SE3","family":["Ana","Luis"], ...}
// Lo que falte se completa con los valores de ejemplo de abajo.

const DEFAULTS = {
  city: "Estocolmo",
  lat: 59.3293,
  lon: 18.0686,
  zone: "SE3",                 // zona de precio de la luz en Suecia: SE1, SE2, SE3 o SE4
  family: ["Ana", "Luis", "Sofía"],
  // Electricidad, en öre/kWh CON IVA (mira tu factura):
  gridOre: 25,                 // transporte de la red (elöverföring), parte variable
  taxOre: 45,                  // impuesto de la energía (energiskatt)
  // Recargo de tu compañía según la fecha en que empieza cada contrato. hourly=true si pagas
  // el precio de cada hora o cuarto de hora; false si pagas la media del mes.
  // monthlyKr: cuota mensual fija de la compañía, con IVA (0 si no tiene)
  contracts: [{ from: "2000-01-01", ore: 8, name: "Contrato de ejemplo (configura el tuyo)", hourly: true, monthlyKr: 0 }],
  gridMonthlyKr: 0,            // cuota fija de la red al mes, con IVA (abonnemang / fast avgift ÷ 12)
  yearKwh: 2400,               // consumo anual aproximado, para estimar hasta anotar facturas
};

let current = DEFAULTS;
let loadedFrom = null;

// Se llama al principio de cada petición (y de cada tarea programada)
export function loadConfig(env) {
  const raw = env && env.NEXUS_HOME;
  if (raw === loadedFrom) return current;
  loadedFrom = raw;
  current = DEFAULTS;
  if (raw) {
    try {
      current = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch (e) {
      console.error("NEXUS_HOME no es JSON válido", e);
    }
  }
  return current;
}

export const config = () => current;
