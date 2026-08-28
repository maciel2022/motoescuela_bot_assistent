CREATE TABLE IF NOT EXISTS contacts (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  wa_id         VARCHAR(32)  NOT NULL,
  profile_name  VARCHAR(255) NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_contacts_wa_id (wa_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversations (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contact_id       BIGINT UNSIGNED NOT NULL,
  status           ENUM('open','closed') NOT NULL DEFAULT 'open',
  last_message_at  TIMESTAMP NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_conversations_contact_status (contact_id, status),
  KEY ix_conversations_last_message_at (last_message_at),
  CONSTRAINT fk_conversations_contact FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id  BIGINT UNSIGNED NOT NULL,
  contact_id       BIGINT UNSIGNED NOT NULL,
  wa_message_id    VARCHAR(128) NULL,
  direction        ENUM('in','out') NOT NULL,
  type             VARCHAR(32)  NOT NULL DEFAULT 'text',
  text             TEXT NULL,
  raw_payload      JSON NULL,
  status           ENUM('received','processed','error') NOT NULL DEFAULT 'received',
  error_text       TEXT NULL,
  wa_timestamp     TIMESTAMP NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_messages_wa_message_id (wa_message_id),
  KEY ix_messages_conversation_created (conversation_id, created_at),
  CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_contact FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
