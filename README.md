# Finanzas

App web instalable (PWA) para llevar gastos, ingresos, deudas y presupuestos desde el iPhone. Los datos se guardan solo en el teléfono (IndexedDB); el servidor únicamente entrega los archivos de la app.

## Qué hace

- Registro manual de gastos, ingresos y transferencias entre cuentas (MXN, EUR, USD).
- Presupuestos mensuales por categoría con aviso al pasar del 80 %.
- Deudas con saldo restante, pago mínimo y fecha de pago; tarjetas de crédito como cuentas.
- Importación de archivos CSV u OFX del banco: mapeo de columnas que se recuerda por cuenta, detección de duplicados y reglas de categorización que aprenden de tus correcciones.
- Respaldo y restauración en un archivo JSON.

## Probar en la computadora

No necesita compilación:

```sh
python3 -m http.server 8000
```

y abre http://localhost:8000.

## Instalar en el iPhone

1. Abre la dirección donde está publicada la app en Safari.
2. Compartir → Añadir a pantalla de inicio.

## Estructura

- `index.html`, `css/styles.css`: interfaz.
- `js/app.js`: pantallas y navegación.
- `js/import-view.js`, `js/importer.js`: importación del banco.
- `js/model.js`: cálculos (saldos, presupuestos, deudas).
- `js/db.js`: almacenamiento local.
- `sw.js`: funcionamiento sin conexión. Sube `VERSION` al publicar cambios.
