import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.MYSQL_URL);

await conn.execute(`
  CREATE TABLE IF NOT EXISTS workflows (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    userId      INT NOT NULL,
    triggerId   INT DEFAULT NULL,
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    isActive    BOOLEAN NOT NULL DEFAULT TRUE,
    createdAt   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_workflows_user_id (userId),
    INDEX idx_workflows_trigger_id (triggerId)
  )
`);
console.log("✓ workflows table ready");

await conn.execute(`
  CREATE TABLE IF NOT EXISTS workflow_steps (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    workflowId      INT NOT NULL,
    position        INT NOT NULL DEFAULT 0,
    type            VARCHAR(64) NOT NULL,
    name            VARCHAR(255) NOT NULL,
    config          JSON NOT NULL,
    continueOnError BOOLEAN NOT NULL DEFAULT FALSE,
    createdAt       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_wf_steps_workflow_id (workflowId)
  )
`);
console.log("✓ workflow_steps table ready");

await conn.execute(`
  CREATE TABLE IF NOT EXISTS workflow_executions (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    workflowId  INT NOT NULL,
    userId      INT NOT NULL,
    status      ENUM('running','success','failed','cancelled') NOT NULL DEFAULT 'running',
    triggerData JSON,
    contextJson JSON,
    startedAt   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completedAt TIMESTAMP NULL,
    error       TEXT,
    INDEX idx_wf_exec_workflow_id (workflowId),
    INDEX idx_wf_exec_user_id (userId),
    INDEX idx_wf_exec_status (status)
  )
`);
console.log("✓ workflow_executions table ready");

await conn.execute(`
  CREATE TABLE IF NOT EXISTS workflow_step_executions (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    executionId INT NOT NULL,
    stepId      INT NOT NULL,
    position    INT NOT NULL,
    status      ENUM('running','success','failed','skipped') NOT NULL DEFAULT 'running',
    inputJson   JSON,
    outputJson  JSON,
    error       TEXT,
    durationMs  INT,
    executedAt  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_wf_step_exec_exec_id (executionId),
    INDEX idx_wf_step_exec_step_id (stepId)
  )
`);
console.log("✓ workflow_step_executions table ready");

await conn.end();
console.log("Migration complete.");
