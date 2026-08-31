-- wa_message_id heredaba utf8mb4_unicode_ci, que compara sin distinguir
-- mayusculas de minusculas. Los wamid de Meta son base64, o sea que
-- 'wamid.AbCd' y 'wamid.abcd' son DISTINTOS pero el indice unico los tomaba
-- como iguales y descartaba el segundo como duplicado: un mensaje legitimo
-- perdido en silencio, en la columna que sostiene la garantia central.
ALTER TABLE messages
  MODIFY COLUMN wa_message_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL;

-- TIMESTAMP topea en 2038-01-19. DATETIME(3) no tiene ese limite y ademas
-- guarda milisegundos. Como la sesion corre en UTC, el significado no cambia.
ALTER TABLE messages
  MODIFY COLUMN wa_timestamp DATETIME(3) NULL;

-- obtenerHistorial ordena por id DESC, pero el unico indice era
-- (conversation_id, created_at): cada respuesta hacia filesort sobre la
-- conversacion entera para quedarse con 10 filas.
ALTER TABLE messages
  ADD KEY ix_messages_conversacion_id (conversation_id, id);

-- Sirve al barrido de pendientes, que busca entrantes en 'received' y viejos.
ALTER TABLE messages
  ADD KEY ix_messages_pendientes (status, direction, created_at);
