/**
 * MovFlow Hub — Real Estate Knowledge Base: SPAIN (es)
 * ────────────────────────────────────────────────────
 * Decoupled per-country module. Each country exports the same shape:
 *   { country, lang, glossary, legal, operationTypes, propertyTypes, ... }
 * so new countries (uk, us, eu, latam, me) can be added without touching
 * the engine. The engine loads modules dynamically by country code.
 *
 * The glossary entries carry: canonical term, category, synonyms/variants
 * (including common misspellings, abbreviations, colloquialisms), and an
 * optional short definition used to enrich the LLM context (RAG retrieval).
 */

export const COUNTRY = 'es';
export const LANG = 'es';

// ── GLOSSARY ──────────────────────────────────────────
// category: operation | property | legal | financial | document | location | condition
export const GLOSSARY = [
  // ─── OPERATIONS ───
  { term: 'compra', category: 'operation', canonical: 'compraventa', syn: ['comprar','adquisición','adquirir','quiero comprar','busco comprar','interesado en comprar','me interesa comprar','purchase'], def: 'Operación de adquisición de un inmueble.' },
  { term: 'venta', category: 'operation', canonical: 'venta', syn: ['vender','poner a la venta','quiero vender','vendo','en venta','sale'], def: 'Operación de transmisión de un inmueble a cambio de precio.' },
  { term: 'alquiler', category: 'operation', canonical: 'alquiler', syn: ['arrendamiento','arrendar','rentar','renta','alquilar','en alquiler','busco alquiler','quiero alquilar','rent','lease'], def: 'Cesión de uso de un inmueble a cambio de renta periódica.' },
  { term: 'alquiler con opción a compra', category: 'operation', canonical: 'alquiler con opción a compra', syn: ['alquiler opcion compra','renta con opcion','lease to own','rent to buy','opcion a compra'], def: 'Arrendamiento que otorga al inquilino el derecho a comprar el inmueble en un plazo pactado.' },
  { term: 'traspaso', category: 'operation', canonical: 'traspaso', syn: ['traspasar','cesion de local','cesión de negocio'], def: 'Cesión de un local de negocio en funcionamiento.' },
  { term: 'permuta', category: 'operation', canonical: 'permuta', syn: ['intercambio de inmuebles','cambiar piso'], def: 'Intercambio de inmuebles entre partes.' },

  // ─── PROPERTY TYPES ───
  { term: 'piso', category: 'property', canonical: 'piso', syn: ['apartamento','vivienda','flat','apartment','departamento'], def: 'Vivienda en edificio de varias plantas.' },
  { term: 'ático', category: 'property', canonical: 'ático', syn: ['atico','penthouse','última planta'], def: 'Vivienda en la planta superior, normalmente con terraza.' },
  { term: 'dúplex', category: 'property', canonical: 'dúplex', syn: ['duplex','dos plantas'], def: 'Vivienda de dos plantas comunicadas internamente.' },
  { term: 'chalet', category: 'property', canonical: 'chalet', syn: ['chalé','casa unifamiliar','villa','casa independiente','adosado','pareado'], def: 'Vivienda unifamiliar.' },
  { term: 'estudio', category: 'property', canonical: 'estudio', syn: ['studio','loft','monoambiente'], def: 'Vivienda de un solo ambiente.' },
  { term: 'local comercial', category: 'property', canonical: 'local comercial', syn: ['local','comercial','bajo comercial','tienda','retail'], def: 'Inmueble destinado a actividad comercial.' },
  { term: 'nave industrial', category: 'property', canonical: 'nave industrial', syn: ['nave','almacen','almacén','warehouse','industrial'], def: 'Inmueble destinado a uso industrial o logístico.' },
  { term: 'oficina', category: 'property', canonical: 'oficina', syn: ['despacho','office','espacio de trabajo'], def: 'Inmueble destinado a uso administrativo.' },
  { term: 'solar urbano', category: 'property', canonical: 'solar urbano', syn: ['solar','parcela urbana','terreno urbano','suelo urbano'], def: 'Terreno clasificado como urbano, apto para edificar.' },
  { term: 'suelo rústico', category: 'property', canonical: 'suelo rústico', syn: ['rustico','terreno rustico','finca rustica','suelo no urbanizable','parcela rustica'], def: 'Terreno no urbanizable, uso agrícola o forestal.' },
  { term: 'garaje', category: 'property', canonical: 'plaza de garaje', syn: ['parking','plaza garaje','aparcamiento','cochera'], def: 'Plaza de aparcamiento.' },
  { term: 'trastero', category: 'property', canonical: 'trastero', syn: ['cuarto trastero','storage'], def: 'Espacio de almacenamiento anexo a vivienda.' },

  // ─── CONDITION / CLASSIFICATION ───
  { term: 'vivienda habitual', category: 'condition', canonical: 'vivienda habitual', syn: ['residencia habitual','primera vivienda','domicilio habitual'], def: 'Vivienda donde reside el titular de forma permanente; con implicaciones fiscales.' },
  { term: 'vivienda vacacional', category: 'condition', canonical: 'vivienda vacacional', syn: ['segunda residencia','casa de vacaciones','vivienda turística','vut','alquiler turistico','holiday let'], def: 'Vivienda de uso turístico o segunda residencia; sujeta a normativa autonómica.' },
  { term: 'vivienda protegida', category: 'condition', canonical: 'vivienda protegida', syn: ['vpo','vpp','proteccion oficial','vivienda de proteccion oficial','vivienda social'], def: 'Vivienda con protección pública y precio limitado.' },
  { term: 'obra nueva', category: 'condition', canonical: 'obra nueva', syn: ['nueva construccion','a estrenar','promocion','new build'], def: 'Inmueble de nueva construcción, sujeto a IVA.' },
  { term: 'segunda mano', category: 'condition', canonical: 'segunda mano', syn: ['usado','de segunda mano','reventa','resale'], def: 'Inmueble usado, sujeto a ITP.' },
  { term: 'para reformar', category: 'condition', canonical: 'para reformar', syn: ['a reformar','necesita reforma','reformar','fixer upper','para actualizar'], def: 'Inmueble que requiere reforma.' },
  { term: 'reformado', category: 'condition', canonical: 'reformado', syn: ['recien reformado','reformado a estrenar','renovado'], def: 'Inmueble que ha sido reformado recientemente.' },

  // ─── FINANCIAL ───
  { term: 'hipoteca', category: 'financial', canonical: 'hipoteca', syn: ['prestamo hipotecario','mortgage','financiacion','financiación','credito hipotecario'], def: 'Préstamo garantizado con el inmueble.' },
  { term: 'tasación', category: 'financial', canonical: 'tasación', syn: ['tasacion','valoracion','valoración','appraisal','valor de tasacion'], def: 'Valoración oficial del inmueble por entidad homologada.' },
  { term: 'arras', category: 'financial', canonical: 'arras', syn: ['contrato de arras','señal','arras penitenciales','deposito','depósito','paga y señal'], def: 'Anticipo que garantiza la compraventa; pueden ser penitenciales, confirmatorias o penales.' },
  { term: 'rentabilidad bruta', category: 'financial', canonical: 'rentabilidad bruta', syn: ['rentabilidad','gross yield','retorno bruto'], def: 'Renta anual / precio de compra, sin descontar gastos.' },
  { term: 'rentabilidad neta', category: 'financial', canonical: 'rentabilidad neta', syn: ['net yield','retorno neto','rentabilidad real'], def: 'Rentabilidad descontando gastos, impuestos y vacancia.' },
  { term: 'yield', category: 'financial', canonical: 'yield', syn: ['rentabilidad','roi','retorno de inversion','cap rate'], def: 'Rendimiento de la inversión inmobiliaria.' },
  { term: 'plusvalía municipal', category: 'financial', canonical: 'plusvalía municipal', syn: ['plusvalia','iivtnu','impuesto plusvalia'], def: 'Impuesto sobre el incremento de valor del terreno urbano en la transmisión.' },
  { term: 'ibi', category: 'financial', canonical: 'IBI', syn: ['impuesto bienes inmuebles','contribucion','impuesto municipal'], def: 'Impuesto sobre Bienes Inmuebles, anual y municipal.' },
  { term: 'itp', category: 'financial', canonical: 'ITP', syn: ['impuesto transmisiones','impuesto de transmisiones patrimoniales','transmisiones patrimoniales'], def: 'Impuesto en compraventa de segunda mano; varía por comunidad autónoma.' },
  { term: 'iva', category: 'financial', canonical: 'IVA', syn: ['impuesto valor añadido','impuesto sobre el valor anadido','vat'], def: 'Impuesto en obra nueva (10% vivienda, 21% locales/suelo).' },
  { term: 'comunidad de propietarios', category: 'financial', canonical: 'comunidad de propietarios', syn: ['gastos de comunidad','cuota comunidad','comunidad','hoa','gastos comunidad'], def: 'Gastos de mantenimiento de zonas comunes.' },
  { term: 'due diligence inmobiliaria', category: 'financial', canonical: 'due diligence', syn: ['due diligence','dd','auditoria inmobiliaria','revision legal'], def: 'Revisión legal, técnica y financiera previa a la compra.' },

  // ─── DOCUMENTS ───
  { term: 'nota simple', category: 'document', canonical: 'nota simple', syn: ['nota registral','nota del registro','informacion registral'], def: 'Documento del Registro de la Propiedad con titularidad y cargas.' },
  { term: 'escritura pública', category: 'document', canonical: 'escritura pública', syn: ['escritura','escritura de compraventa','titulo de propiedad','deed'], def: 'Documento notarial que formaliza la compraventa.' },
  { term: 'referencia catastral', category: 'document', canonical: 'referencia catastral', syn: ['ref catastral','refcat','catastro ref'], def: 'Identificador único del inmueble en el Catastro.' },
  { term: 'catastro', category: 'document', canonical: 'catastro', syn: ['catastral','sede catastro'], def: 'Registro administrativo de bienes inmuebles con fines fiscales.' },
  { term: 'certificado energético', category: 'document', canonical: 'certificado energético', syn: ['certificado de eficiencia energetica','cee','etiqueta energetica','certificado energetico'], def: 'Documento obligatorio que califica la eficiencia energética (A-G).' },
  { term: 'cédula de habitabilidad', category: 'document', canonical: 'cédula de habitabilidad', syn: ['cedula habitabilidad','cedula','licencia de habitabilidad'], def: 'Documento que acredita que la vivienda cumple condiciones mínimas de habitabilidad.' },
  { term: 'licencia de primera ocupación', category: 'document', canonical: 'licencia de primera ocupación', syn: ['licencia primera ocupacion','lpo','primera ocupacion'], def: 'Licencia municipal que autoriza el uso de una edificación nueva.' },
  { term: 'licencia de obra', category: 'document', canonical: 'licencia de obra', syn: ['licencia obras','permiso de obra','licencia urbanistica'], def: 'Autorización municipal para ejecutar obras.' },

  // ─── LEGAL ───
  { term: 'registro de la propiedad', category: 'legal', canonical: 'Registro de la Propiedad', syn: ['registro propiedad','registro','inscripcion registral'], def: 'Registro público de titularidades y cargas sobre inmuebles.' },
  { term: 'cargas', category: 'legal', canonical: 'cargas', syn: ['embargo','embargos','hipoteca previa','servidumbre','afecciones','gravamen','gravámenes'], def: 'Gravámenes que pesan sobre el inmueble (hipotecas, embargos, servidumbres).' },
  { term: 'okupa', category: 'legal', canonical: 'ocupación ilegal', syn: ['okupas','ocupacion ilegal','ocupado','squatter'], def: 'Ocupación sin título legal del inmueble; riesgo relevante en compraventa.' },
  { term: 'usufructo', category: 'legal', canonical: 'usufructo', syn: ['nuda propiedad','derecho de uso'], def: 'Derecho a usar y disfrutar un bien ajeno.' },
];

// ── LEGAL KNOWLEDGE (context for interpretation, NOT legal advice) ──
export const LEGAL = [
  { id: 'lau', name: 'Ley de Arrendamientos Urbanos (LAU)', scope: 'alquiler', summary: 'Regula los arrendamientos de vivienda y uso distinto. Duración mínima, prórrogas, fianza, actualización de renta.', triggers: ['alquiler','arrendamiento','inquilino','fianza','contrato de alquiler','renta'] },
  { id: 'lph', name: 'Ley de Propiedad Horizontal (LPH)', scope: 'comunidad', summary: 'Regula comunidades de propietarios, cuotas, juntas, obras y zonas comunes.', triggers: ['comunidad de propietarios','cuota','junta','zonas comunes','derrama'] },
  { id: 'hipotecaria', name: 'Ley Hipotecaria', scope: 'compraventa', summary: 'Regula el Registro de la Propiedad, inscripción, cargas y garantías hipotecarias.', triggers: ['hipoteca','registro','nota simple','cargas','inscripcion'] },
  { id: 'suelo', name: 'Ley del Suelo', scope: 'urbanismo', summary: 'Clasificación del suelo (urbano, urbanizable, rústico) y régimen de edificación.', triggers: ['suelo','solar','rustico','urbanizable','parcela','edificabilidad'] },
  { id: 'fiscalidad', name: 'Fiscalidad inmobiliaria', scope: 'impuestos', summary: 'ITP en segunda mano (varía por CCAA, ~6-10%), IVA en obra nueva (10% vivienda), plusvalía municipal, IBI anual.', triggers: ['itp','iva','plusvalia','ibi','impuesto','fiscalidad'] },
  { id: 'consumidores', name: 'Protección de consumidores', scope: 'compraventa', summary: 'Obligaciones de información, certificado energético obligatorio, transparencia en gastos.', triggers: ['certificado energetico','informacion','transparencia','consumidor'] },
];

export const URGENCY_SIGNALS = ['urgente','cuanto antes','rápido','rapido','ya','inmediato','esta semana','hoy','prisa','asap','necesito ya','lo antes posible'];

export default { COUNTRY, LANG, GLOSSARY, LEGAL, URGENCY_SIGNALS };
