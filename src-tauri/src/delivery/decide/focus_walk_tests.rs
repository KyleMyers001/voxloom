use super::*;

#[derive(Clone, Default)]
struct N {
    id: usize,
    focused: bool,
    role: &'static str,
    subrole: Option<&'static str>,
    pid: i32,
    kids: Vec<usize>,
}

struct Tree {
    nodes: Vec<N>,
    clock: u64,
    tick: u64,
}

impl Tree {
    fn new(nodes: Vec<N>) -> Self {
        Self {
            nodes,
            clock: 0,
            tick: 0,
        }
    }
}

impl AxTree for Tree {
    type Node = usize;
    fn children(&mut self, n: &usize) -> Vec<usize> {
        self.clock += self.tick;
        self.nodes[*n].kids.clone()
    }
    fn is_focused(&mut self, n: &usize) -> bool {
        self.nodes[*n].focused
    }
    fn role(&mut self, n: &usize) -> Option<String> {
        Some(self.nodes[*n].role.to_string())
    }
    fn subrole(&mut self, n: &usize) -> Option<String> {
        self.nodes[*n].subrole.map(str::to_string)
    }
    fn pid(&mut self, n: &usize) -> Option<i32> {
        Some(self.nodes[*n].pid)
    }
    fn elapsed_ms(&self) -> u64 {
        self.clock
    }
}

fn node(id: usize, role: &'static str, kids: Vec<usize>) -> N {
    N {
        id,
        role,
        pid: 42,
        kids,
        ..Default::default()
    }
}

fn window(field: N) -> Vec<N> {
    let mut web = node(2, "AXWebArea", vec![3]);
    web.focused = true; // focused container is not a hit
    vec![
        node(0, "AXWindow", vec![1]),
        node(1, "AXGroup", vec![2]),
        web,
        field,
    ]
}

#[test]
fn finds_focused_text_area_beneath_focused_web_area() {
    let mut f = node(3, "AXTextArea", vec![]);
    f.focused = true;
    let mut t = Tree::new(window(f));
    assert_eq!(find_focused(&mut t, 0, 42), WalkOutcome::Found(3));
    assert_eq!(t.nodes[3].id, 3);
}

#[test]
fn secure_field_by_role_or_subrole_is_refused() {
    let mut f = node(3, "AXTextField", vec![]);
    f.focused = true;
    f.subrole = Some("AXSecureTextField");
    assert_eq!(
        find_focused(&mut Tree::new(window(f)), 0, 42),
        WalkOutcome::Secure
    );
    let mut f = node(3, "AXSecureTextField", vec![]);
    f.focused = true;
    assert_eq!(
        find_focused(&mut Tree::new(window(f)), 0, 42),
        WalkOutcome::Secure
    );
}

#[test]
fn foreign_pid_is_refused() {
    let mut f = node(3, "AXTextArea", vec![]);
    f.focused = true;
    f.pid = 7;
    assert_eq!(
        find_focused(&mut Tree::new(window(f)), 0, 42),
        WalkOutcome::PidMismatch
    );
}

#[test]
fn unfocused_or_non_insertable_fields_are_not_found() {
    let f = node(3, "AXTextArea", vec![]);
    assert_eq!(
        find_focused(&mut Tree::new(window(f)), 0, 42),
        WalkOutcome::NotFound { visited: 4 }
    );
    let mut f = node(3, "AXButton", vec![]);
    f.focused = true;
    assert!(matches!(
        find_focused(&mut Tree::new(window(f)), 0, 42),
        WalkOutcome::NotFound { .. }
    ));
}

#[test]
fn node_depth_and_time_budgets_stop_the_walk() {
    // A long chain deeper than the depth limit never reaches the field.
    let n = WALK_MAX_DEPTH + 5;
    let mut nodes: Vec<N> = (0..n).map(|i| node(i, "AXGroup", vec![i + 1])).collect();
    let mut f = node(n, "AXTextArea", vec![]);
    f.focused = true;
    nodes.push(f);
    assert!(matches!(
        find_focused(&mut Tree::new(nodes), 0, 42),
        WalkOutcome::NotFound { .. }
    ));
    // Wide tree exceeds the node budget.
    let mut nodes = vec![node(0, "AXWindow", (1..=WALK_MAX_NODES + 10).collect())];
    nodes.extend((1..=WALK_MAX_NODES + 10).map(|i| node(i, "AXGroup", vec![])));
    assert_eq!(
        find_focused(&mut Tree::new(nodes), 0, 42),
        WalkOutcome::Budget {
            visited: WALK_MAX_NODES
        }
    );
    // Slow AX reads hit the time budget.
    let mut f = node(3, "AXTextArea", vec![]);
    f.focused = true;
    let mut t = Tree::new(window(f));
    t.tick = WALK_MAX_MS;
    assert!(matches!(
        find_focused(&mut t, 0, 42),
        WalkOutcome::Budget { .. }
    ));
}

#[test]
fn describe_has_no_field_text() {
    assert_eq!(
        WalkOutcome::<()>::Secure.describe(),
        "focused secure field (refused)"
    );
    assert_eq!(
        WalkOutcome::<()>::NotFound { visited: 9 }.describe(),
        "no focused field in 9 nodes"
    );
}
