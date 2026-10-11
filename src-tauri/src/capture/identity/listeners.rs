pub(super) trait ListenerOperations {
    type Registration;
    type Target;

    fn register(&mut self, target: Self::Target) -> Result<Self::Registration, String>;

    fn remove(&mut self, registration: &Self::Registration) -> Result<(), String>;

    fn synchronize(&self);

    fn quarantine(&mut self) {}
}

pub(super) struct ListenerOwner<O: ListenerOperations> {
    operations: Option<O>,
    registrations: Vec<O::Registration>,
}

impl<O: ListenerOperations> ListenerOwner<O> {
    pub fn new(operations: O) -> Self {
        Self {
            operations: Some(operations),
            registrations: Vec::new(),
        }
    }

    pub fn register(&mut self, target: O::Target) -> Result<(), String> {
        let registration = self.operations_mut().register(target)?;
        self.registrations.push(registration);
        Ok(())
    }

    pub fn synchronize(&self) {
        self.operations().synchronize();
    }

    pub fn finish(mut self) -> Result<(), String> {
        match self.remove_once() {
            Ok(()) => Ok(()),
            Err(_) => match self.remove_once() {
                Ok(()) => Ok(()),
                Err(error) => {
                    self.quarantine();
                    Err(error)
                }
            },
        }
    }

    fn operations(&self) -> &O {
        self.operations
            .as_ref()
            .expect("listener operations exist until quarantine")
    }

    fn operations_mut(&mut self) -> &mut O {
        self.operations
            .as_mut()
            .expect("listener operations exist until quarantine")
    }

    fn quarantine(&mut self) {
        self.operations_mut().quarantine();
        let registrations = std::mem::take(&mut self.registrations);
        let operations = self.operations.take();
        std::mem::forget(registrations);
        std::mem::forget(operations);
    }

    fn remove_once(&mut self) -> Result<(), String> {
        if self.registrations.is_empty() {
            return Ok(());
        }
        let registrations = std::mem::take(&mut self.registrations);
        let mut failed = Vec::new();
        let mut removed = Vec::new();
        let mut first_error = None;
        for registration in registrations.into_iter().rev() {
            if let Err(error) = self.operations_mut().remove(&registration) {
                first_error.get_or_insert(error);
                failed.push(registration);
            } else {
                removed.push(registration);
            }
        }
        failed.reverse();
        self.registrations = failed;
        self.operations().synchronize();
        drop(removed);
        first_error.map_or(Ok(()), Err)
    }
}

impl<O: ListenerOperations> Drop for ListenerOwner<O> {
    fn drop(&mut self) {
        if self.remove_once().is_err() && self.remove_once().is_err() {
            self.quarantine();
        }
    }
}
