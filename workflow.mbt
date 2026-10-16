///|
priv struct WorkflowState {
  mut kind : String
  mut fields : Array[String]
  person_field : String
  origin : String
  mut cap : Int32
  mut sensitivity : Int32
  mut release : String
  mut status : String
  path : Array[String]
}

///|
priv enum WorkflowOperation {
  SelectFields(Array[String])
  BoundPerson(Int32, String)
  Aggregate(String, String, Int32, String)
  DpRelease(Int32, String)
  Postprocess
  Unsupported
}

///|
fn workflow_id(value : Json) -> String raise KitError {
  let name : String = decode(value)
  if name.is_empty() ||
    name.length() > 64 ||
    !name
    .iter()
    .all(c => {
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      c == '-' ||
      c == '_'
    }) {
    raise KitError(
      "workflow identifiers require 1 to 64 ASCII letters, digits, hyphens or underscores",
    )
  }
  name
}

///|
fn workflow_fields(value : Json) -> Array[String] raise KitError {
  let names : Array[String] = decode(value)
  if names.length() > 32 {
    raise KitError("workflow supports at most 32 fields per table")
  }
  let seen : Map[String, Bool] = Map([])
  for name in names {
    table_field_name(name)
    if seen.contains(name) {
      raise KitError("duplicate workflow field")
    }
    seen[name] = true
  }
  names
}

///|
fn workflow_origin(value : Json) -> String raise KitError {
  let origin : String = decode(value)
  if !["public", "private", "unknown"].contains(origin) {
    raise KitError("parameter origin must be public, private or unknown")
  }
  origin
}

///|
fn workflow_operation(
  op : String,
  settings : Json,
) -> WorkflowOperation raise KitError {
  match op {
    "select_fields" => {
      require_keys(settings, ["keep"])
      SelectFields(workflow_fields(field(settings, "keep")))
    }
    "bound_person" => {
      require_keys(settings, ["max_rows", "origin"])
      let cap = decode_int(field(settings, "max_rows"))
      if cap < 1 || cap > 32 {
        raise KitError("person contribution cap must be 1 to 32")
      }
      BoundPerson(cap, workflow_origin(field(settings, "origin")))
    }
    "aggregate" => {
      require_keys(settings, ["query", "value_field", "upper", "origin"])
      let query : String = decode(field(settings, "query"))
      let name : String = decode(field(settings, "value_field"))
      let upper = decode_int(field(settings, "upper"))
      let origin = workflow_origin(field(settings, "origin"))
      if query == "count" {
        if name != "" || upper != 1 || origin != "public" {
          raise KitError(
            "count requires an empty value field, upper 1 and public origin",
          )
        }
      } else if query == "bounded_sum" {
        table_field_name(name)
        if upper < 1 || upper > 1000 {
          raise KitError("integer upper bound must be 1 to 1000")
        }
      } else {
        raise KitError("workflow aggregation supports count or bounded_sum")
      }
      Aggregate(query, name, upper, origin)
    }
    "dp_release" => {
      require_keys(settings, ["epsilon_units", "trust"])
      let epsilon = decode_int(field(settings, "epsilon_units"))
      let trust : String = decode(field(settings, "trust"))
      if epsilon < 1 || epsilon > 10000000 {
        raise KitError("release epsilon must be 1 to 10000000 millionths")
      }
      if !["trusted_holder", "untrusted"].contains(trust) {
        raise KitError("unknown release trust model")
      }
      DpRelease(epsilon, trust)
    }
    "postprocess" => {
      require_keys(settings, ["format"])
      let format : String = decode(field(settings, "format"))
      if !["table", "chart"].contains(format) {
        raise KitError("supported postprocessing formats are table and chart")
      }
      Postprocess
    }
    _ => {
      match settings {
        Object(_) => ()
        _ => raise KitError("step settings must be an object")
      }
      Unsupported
    }
  }
}

///|
fn workflow_problem(
  state : WorkflowState,
  issues : Array[Json],
  code : String,
  reason : String,
  action : String,
  unverified~ : Bool = false,
) -> Unit {
  if state.status != "blocked" {
    state.status = if unverified { "unverified" } else { "blocked" }
  }
  issues.push({
    "node": Json(state.path[state.path.length() - 1]),
    "code": Json(code),
    "reason": Json(reason),
    "action": Json(action),
    "path": Json(state.path),
    "severity": Json(if unverified { "unverified" } else { "blocked" }),
  })
}

///|
fn workflow_public(
  origin : String,
  state : WorkflowState,
  issues : Array[Json],
) -> Unit {
  if origin != "public" {
    workflow_problem(
      state,
      issues,
      "PARAMETER_NOT_PUBLIC",
      "当前规则或参数来自私有数据，或其来源尚未确认。",
      "使用独立于当前私有数据的公开规则；经隐私机制选出的参数需另行核对预算和组合条件。",
      unverified=origin == "unknown",
    )
  }
}

///|
fn workflow_description(
  id : String,
  op : String,
  state : WorkflowState,
) -> Json {
  {
    "node": Json(id),
    "operation": Json(op),
    "status": Json(state.status),
    "data_kind": Json(state.kind),
    "fields": Json(state.fields),
    "person_field_available": Json(
      state.person_field != "" && state.fields.contains(state.person_field),
    ),
    "rows_per_person": if state.cap > 0 {
      Json(state.cap)
    } else {
      Json::null()
    },
    "l1_sensitivity": if state.sensitivity > 0 {
      Json(state.sensitivity)
    } else {
      Json::null()
    },
    "release_node": if state.release != "" {
      Json(state.release)
    } else {
      Json::null()
    },
    "path": Json(state.path),
  }
}

///|
/// Checks declarations, not data or execution. There is one declared person-level
/// composition scope; every distinct release step spends once in the plan.
pub fn check_privacy_workflow(input : String) -> Json raise KitError {
  if input.length() > 128000 {
    raise KitError("workflow document exceeds 128000 characters")
  }
  let plan = read_json(input)
  reject_duplicate_table_keys(input)
  require_keys(plan, [
    "schema_version", "kind", "scope", "budget", "sources", "steps", "outputs",
  ])
  let kind : String = decode(field(plan, "kind"))
  if decode_int(field(plan, "schema_version")) != 1 ||
    kind != "moonprivacykit/privacy-workflow" {
    raise KitError("unsupported workflow schema")
  }
  let scope = workflow_id(field(plan, "scope"))
  let budget = field(plan, "budget")
  require_keys(budget, ["total_epsilon_units", "spent_epsilon_units"])
  let total = decode_int(field(budget, "total_epsilon_units"))
  let spent = decode_int(field(budget, "spent_epsilon_units"))
  if total < 1 || total > 1000000000 || spent < 0 || spent > total {
    raise KitError("invalid workflow budget snapshot")
  }
  let sources : Array[Json] = decode(field(plan, "sources"))
  let steps : Array[Json] = decode(field(plan, "steps"))
  let outputs : Array[Json] = decode(field(plan, "outputs"))
  if sources.is_empty() ||
    sources.length() > 8 ||
    steps.length() > 32 ||
    outputs.is_empty() ||
    outputs.length() > 16 {
    raise KitError(
      "workflow requires 1 to 8 sources, at most 32 steps and 1 to 16 outputs",
    )
  }
  let states : Map[String, WorkflowState] = Map([])
  let checks : Array[Json] = []
  let issues : Array[Json] = []
  let output_checks : Array[Json] = []
  let mut planned = 0
  for source in sources {
    require_keys(source, [
      "id", "kind", "fields", "person_field", "selection_origin",
    ])
    let id = workflow_id(field(source, "id"))
    let kind : String = decode(field(source, "kind"))
    let fields = workflow_fields(field(source, "fields"))
    let person_field : String = decode(field(source, "person_field"))
    if states.contains(id) {
      raise KitError("workflow node identifiers must be unique")
    }
    if kind == "private_table" {
      if fields.is_empty() ||
        (person_field != "" && !fields.contains(person_field)) {
        raise KitError(
          "table source must list its fields and declared person field",
        )
      }
    } else if kind == "exact_joint_total" {
      if !fields.is_empty() || person_field != "" {
        raise KitError("joint total is not a table")
      }
    } else {
      raise KitError(
        "unsupported source kind; protected reports cannot be self-declared as sources",
      )
    }
    let state : WorkflowState = {
      kind,
      fields,
      person_field,
      origin: workflow_origin(field(source, "selection_origin")),
      cap: 0,
      sensitivity: 0,
      release: "",
      status: "valid",
      path: [id],
    }
    states[id] = state
    checks.push(workflow_description(id, "source", state))
  }
  for step in steps {
    require_keys(step, ["id", "op", "input", "settings"])
    let id = workflow_id(field(step, "id"))
    let op = workflow_id(field(step, "op"))
    let parent = workflow_id(field(step, "input"))
    if states.contains(id) {
      raise KitError("workflow node identifiers must be unique")
    }
    let previous = match states.get(parent) {
      Some(value) => value
      None =>
        raise KitError(
          "each step must reference an earlier node; cycles and forward references are unsupported",
        )
    }
    let operation = workflow_operation(op, field(step, "settings"))
    let path = previous.path.copy()
    path.push(id)
    // A fresh state per edge prevents one branch from changing a sibling.
    let state : WorkflowState = {
      kind: previous.kind,
      fields: previous.fields.copy(),
      person_field: previous.person_field,
      origin: previous.origin,
      cap: previous.cap,
      sensitivity: previous.sensitivity,
      release: previous.release,
      status: previous.status,
      path,
    }
    if state.status == "valid" {
      match operation {
        SelectFields(keep) =>
          if state.kind != "private_table" {
            workflow_problem(
              state, issues, "TABLE_REQUIRED", "此步骤需要私有明细表。",
              "为此步骤选择表格输入。",
            )
          } else if keep.any(name => !state.fields.contains(name)) {
            workflow_problem(
              state, issues, "FIELD_UNAVAILABLE", "保留字段在上一步已不存在。",
              "核对字段处理顺序和字段名称。",
            )
          } else {
            state.fields = keep
          }
        BoundPerson(cap, origin) =>
          if state.kind != "private_table" {
            workflow_problem(
              state, issues, "TABLE_REQUIRED", "按人限制贡献需要私有明细表。",
              "在统计合计前执行贡献限制。",
            )
          } else if state.person_field == "" ||
            !state.fields.contains(state.person_field) {
            workflow_problem(
              state, issues, "PERSON_FIELD_MISSING", "人员标识缺失，不能执行按人贡献限制。",
              "先按人限制贡献，再移除标识；或保留可信的人员标识供此步骤使用。",
            )
          } else {
            workflow_public(origin, state, issues)
            if state.cap == 0 || cap < state.cap {
              state.cap = cap
            }
          }
        Aggregate(query, name, upper, origin) =>
          if state.kind != "private_table" {
            workflow_problem(
              state, issues, "TABLE_REQUIRED", "计数或求和需要私有明细表。",
              "选择明细输入；已有合计不能重新解释为明细。",
            )
          } else if query == "bounded_sum" &&
            (!state.fields.contains(name) || name == state.person_field) {
            workflow_problem(
              state, issues, "VALUE_FIELD_UNAVAILABLE", "有界整数和缺少可用的数值字段。",
              "选择保留的非人员标识字段。",
            )
          } else {
            workflow_public(origin, state, issues)
            state.sensitivity = state.cap * upper
            state.fields = []
            state.kind = "exact_total"
          }
        DpRelease(epsilon, trust) =>
          if state.kind == "exact_joint_total" {
            workflow_problem(
              state,
              issues,
              "JOINT_BOUND_UNVERIFIED",
              "加密联合合计未提供经核对的按人敏感度与分布式发布条件。",
              "保留内部用途；联合受保护发布需要单独协议，不能把它当作中心化明细统计。",
              unverified=true,
            )
          } else if state.kind != "exact_total" {
            workflow_problem(
              state, issues, "EXACT_TOTAL_REQUIRED", "此发布步骤需要经过贡献约束的内部合计。",
              "先限定每人贡献并计算合计；已有受保护结果用后处理复用。",
            )
          } else if state.sensitivity < 1 {
            workflow_problem(
              state, issues, "PERSON_BOUND_MISSING", "尚未建立按人的贡献上限和敏感度。",
              "在合计前加入按人贡献限制。",
            )
          } else if trust != "trusted_holder" {
            workflow_problem(
              state, issues, "TRUST_MISMATCH", "中心化发布需要可信数据持有方。",
              "由可信持有者执行，或另选经过验证的分布式协议。",
            )
          } else {
            workflow_public(state.origin, state, issues)
            if state.status == "valid" {
              planned += epsilon
              if planned > total - spent {
                workflow_problem(
                  state, issues, "BUDGET_EXCEEDED", "同一保护范围内的计划发布超过剩余预算。",
                  "减少新发布、复用已有结果或调整计划；切换工具和分支不重置预算。",
                )
              } else {
                state.kind = "dp_report"
                state.release = id
              }
            }
          }
        Postprocess =>
          if state.kind != "dp_report" {
            workflow_problem(
              state, issues, "PROTECTED_REPORT_REQUIRED", "图表或表格复用需要已经受保护的统计结果。",
              "先执行受保护发布；格式转换不会消除原始数据的隐私风险。",
            )
          }
        Unsupported => {
          state.kind = "unknown"
          workflow_problem(
            state,
            issues,
            "UNSUPPORTED_OPERATION",
            "当前检查器不支持此操作。",
            "使用已支持的步骤；自定义代码、关联和外部机制需要单独验证。",
            unverified=true,
          )
        }
      }
    }
    states[id] = state
    checks.push(workflow_description(id, op, state))
  }
  let destinations : Map[String, Bool] = Map([])
  for output in outputs {
    require_keys(output, ["node", "audience"])
    let id = workflow_id(field(output, "node"))
    let audience : String = decode(field(output, "audience"))
    if !["internal", "public"].contains(audience) {
      raise KitError("output audience must be internal or public")
    }
    let key = id + ":" + audience
    if destinations.contains(key) {
      raise KitError("duplicate output destination")
    }
    destinations[key] = true
    let state = match states.get(id) {
      Some(value) => value
      None => raise KitError("output references an unknown node")
    }
    let mut status = state.status
    if status == "valid" && audience == "public" && state.kind != "dp_report" {
      status = "blocked"
      issues.push({
        "node": Json(id),
        "code": "OUTPUT_NOT_PROTECTED",
        "severity": "blocked",
        "reason": "计划公开的结果仍是明细或精确合计，未满足本检查器的按人差分隐私发布要求。",
        "action": "改为内部使用，或先完成适用的受保护发布。字段删除和加密计算不自动保护公开输出。",
        "path": Json(state.path),
      })
    }
    output_checks.push({
      "node": Json(id),
      "audience": Json(audience),
      "status": Json(status),
      "data_kind": Json(state.kind),
      "release_node": Json(state.release),
      "path": Json(state.path),
    })
  }
  let blocked = issues.any(i => field(i, "severity") == Json("blocked"))
  let status = if blocked {
    "blocked"
  } else if !issues.is_empty() {
    "inconclusive"
  } else {
    "compatible"
  }
  {
    "schema_version": 1,
    "kind": "moonprivacykit/workflow-check",
    "scope": Json(scope),
    "status": Json(status),
    "protection_unit": "add_remove_person",
    "checks": Json(checks),
    "issues": Json(issues),
    "outputs": Json(output_checks),
    "budget": {
      "total_epsilon_units": Json(total),
      "spent_epsilon_units": Json(spent),
      "planned_epsilon_units": Json(planned),
      "remaining_after_plan_units": Json(total - spent - planned),
      "estimate_complete": Json(status == "compatible"),
      "charged": false,
    },
    "assumptions": [
      "字段、人员对应、参数来源、共同保护范围和预算快照由使用者声明，检查器不验证其真实性。",
      "仅检查列出的操作及其顺序；未执行数据处理、签发发布许可或改变实际账本。",
      "公开输出按此处的按人差分隐私目标检查；其他合理发布模型不在本版支持范围。",
    ],
  }
}
