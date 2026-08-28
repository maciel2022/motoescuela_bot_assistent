-- Impide que un contacto tenga dos conversaciones abiertas a la vez.
--
-- obtenerOCrearConversacion consulta y despues inserta; dos webhooks
-- simultaneos del mismo contacto pueden ver ambos "no hay conversacion"
-- antes de que ninguno haya insertado. El resultado es el historial del
-- usuario partido en dos conversaciones, con lo que el bot parece perder
-- el contexto.
--
-- La columna generada vale contact_id mientras la conversacion esta abierta
-- y NULL cuando se cierra. Como MySQL permite multiples NULL en un indice
-- unico, un contacto puede acumular cuantas conversaciones cerradas quiera,
-- pero solo una abierta.
ALTER TABLE conversations
  ADD COLUMN open_key BIGINT UNSIGNED
    GENERATED ALWAYS AS (IF(status = 'open', contact_id, NULL)) VIRTUAL,
  ADD UNIQUE KEY uq_conversations_abierta (open_key);
